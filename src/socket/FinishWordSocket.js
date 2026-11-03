const { FinishWordGame } = require("../services/FinishWordGame");

const FINISH_WORD_CHARACTERS = Object.freeze(["knight", "wizard", "ninja", "robot", "alien", "pirate", "astronaut", "dino"]);

// Transport and scheduling live here; the rules and SQLite queries are injected
// so deadline handling can be tested without a browser or wall-clock sleeps.
class FinishWordRounds {
  constructor({ io, rooms, publicPlayers, dictionary, game, onLobbyChanged }) {
    Object.assign(this, { io, rooms, publicPlayers, dictionary, onLobbyChanged });
    this.game = game || new FinishWordGame({ isValidWord: (word) => dictionary.isValidWord(word),
      getStartingPrefixes: (length, usedWords) => dictionary.getStartingPrefixes(length, usedWords) });
    this.timers = new Map();
    this.typingTimers = new Map();
  }

  state(room, playerId) {
    const state = this.game.publicState(room.finishWordGame, playerId);
    const presence = new Map(this.publicPlayers(room).map((player) => [player.id, player]));
    return { ...state, code: room.code, roomId: room.code, creatorId: room.creatorId,
      maxPlayers: room.maxPlayers, pausedAt: room.pausedAt || null,
      players: state.players.map((player) => ({ ...presence.get(player.id), ...player })),
    };
  }

  snapshot(room, playerId) {
    const state = this.state(room, playerId);
    return state.status === "ENDED" ? { result: state } : { gameState: state };
  }

  start(room) {
    if (!this.dictionary.count) throw new Error("The word dictionary is empty. Import clean-words.txt first.");
    this.clear(room.code);
    room.finishWordGame = this.game.start(room.players);
    room.state = "playing";
    room.players.forEach((player) => { player.ready = false; });
    this.publish(room, true);
    this.schedule(room);
  }

  publish(room, newTurn = false) {
    const state = this.state(room);
    if (state.status === "ENDED") {
      room.state = "ended";
      this.clear(room.code);
      if (!room.finishWordGame.winnerAwarded && state.winnerId) {
        const winner = room.players.find((player) => player.id === state.winnerId);
        if (winner) winner.wins = (winner.wins || 0) + 1;
        room.finishWordGame.winnerAwarded = true;
      }
      this.io.to(room.code).emit("game_over", state);
    } else {
      this.io.to(room.code).emit(newTurn ? "turn_start" : "game_state", state);
      if (state.awaitingStartingLetterChoice) {
        const firstPlayer = room.players.find((player) => player.id === state.currentPlayerId);
        if (firstPlayer?.connected !== false && firstPlayer?.socketId) this.io.to(firstPlayer.socketId).emit("starting_letter_choices", {
          code: room.code, gameId: state.gameId, turnId: state.turnId, playerId: firstPlayer.id,
          choices: this.game.publicState(room.finishWordGame, firstPlayer.id).startingLetterChoices,
        });
      }
    }
  }

  schedule(room) {
    this.clear(room.code);
    const game = room.finishWordGame;
    if (room.pausedAt || room.state !== "playing" || game.status !== "PLAYING") return;
    const turnId = game.turnId;
    const timer = setTimeout(() => {
      if (this.rooms[room.code] !== room || room.pausedAt || room.finishWordGame !== game) return;
      const outcome = this.game.expire(game, turnId);
      if (outcome) this.resolve(room, outcome);
      else this.schedule(room);
    }, Math.max(1, game.turnEndsAt - this.game.now()));
    timer.unref();
    this.timers.set(room.code, timer);
  }

  clear(code) {
    clearTimeout(this.timers.get(code));
    this.timers.delete(code);
    this.clearTyping(code);
  }

  clearTyping(code) {
    clearTimeout(this.typingTimers.get(code));
    this.typingTimers.delete(code);
  }

  resume(room, pauseDuration) {
    if (!room.finishWordGame) return;
    this.game.resume(room.finishWordGame, pauseDuration);
    this.schedule(room);
  }

  removePlayer(room, playerId) {
    if (!room.finishWordGame) return;
    const previousTurn = room.finishWordGame.turnId;
    const outcome = this.game.removePlayer(room.finishWordGame, playerId);
    // A fresh turn created during a pause gets its full duration on resume;
    // the earlier disconnected player's waiting time is not extra play time.
    if (room.pausedAt && room.finishWordGame.status === "PLAYING" && room.finishWordGame.turnId !== previousTurn) {
      room.finishWordGame.turnEndsAt = room.pausedAt + room.finishWordGame.turnDuration * 1000;
    }
    if (outcome?.eliminatedPlayerIds?.length) this.io.to(room.code).emit("player_eliminated", {
      code: room.code, gameId: room.finishWordGame.id, playerIds: outcome.eliminatedPlayerIds,
    });
    this.publish(room);
    this.schedule(room);
  }

  resolve(room, outcome) {
    this.io.to(room.code).emit(outcome.accepted ? "word_accepted" : "word_rejected", {
      ...outcome, code: room.code, gameId: room.finishWordGame.id, serverNow: this.game.now(),
      ...(outcome.retryable ? { turnId: room.finishWordGame.turnId } : {}),
    });
    // Clear the rejected draft for every spectator without resetting the timer.
    if (outcome.retryable) {
      this.clearTyping(room.code);
      this.io.to(room.code).emit("player_typing", { code: room.code, gameId: room.finishWordGame.id,
        turnId: room.finishWordGame.turnId, playerId: outcome.playerId, text: "" });
      return;
    }
    if (outcome.eliminatedPlayerIds?.length) this.io.to(room.code).emit("player_eliminated", {
      code: room.code, gameId: room.finishWordGame.id, playerIds: outcome.eliminatedPlayerIds,
    });
    this.publish(room, true);
    this.schedule(room);
  }

  requirePlayer(socket, payload) {
    const code = payload?.code || payload?.roomId;
    const room = this.rooms[code];
    const player = room?.players.find((candidate) => candidate.id === socket.data.playerId && candidate.socketId === socket.id && candidate.connected !== false);
    if (!room || room.gameMode !== "finish-word" || socket.data.lobbyCode !== room.code || !player) throw new Error("You are not an active member of this Finish the Word room.");
    if (room.pausedAt) throw new Error("The room is paused while a player reconnects.");
    return { room, player };
  }

  register(socket) {
    socket.on("choose_starting_letter", (payload = {}, reply) => {
      try {
        const { room, player } = this.requirePlayer(socket, payload);
        if (room.state !== "playing") throw new Error("The match is not accepting a starting letter.");
        const requiredPrefix = this.game.chooseStartingLetter(room.finishWordGame, { playerId: player.id, turnId: payload.turnId, letter: payload.letter });
        this.publish(room);
        if (typeof reply === "function") reply({ success: true, requiredPrefix, turnId: room.finishWordGame.turnId });
      } catch (error) { if (typeof reply === "function") reply({ success: false, message: error.message }); }
    });

    socket.on("select_character", (payload = {}, reply) => {
      try {
        const { room, player } = this.requirePlayer(socket, payload);
        if (room.state !== "waiting") throw new Error("Characters can only be selected in the lobby.");
        if (!FINISH_WORD_CHARACTERS.includes(payload.characterId)) throw new Error("Choose one of the eight characters.");
        if (room.players.some((candidate) => candidate.id !== player.id && candidate.characterId === payload.characterId)) throw new Error("That character has already been selected.");
        const changed = player.characterId !== payload.characterId;
        if (changed) player.ready = false;
        player.characterId = payload.characterId;
        const players = this.publicPlayers(room);
        const state = { code: room.code, roomId: room.code, players, creatorId: room.creatorId,
          availableCharacters: FINISH_WORD_CHARACTERS.filter((id) => !players.some((candidate) => candidate.characterId === id)) };
        this.io.to(room.code).emit("character_selected", state);
        if (changed) this.onLobbyChanged?.(room);
        if (typeof reply === "function") reply({ success: true, ...state });
      } catch (error) { if (typeof reply === "function") reply({ success: false, message: error.message }); }
    });

    socket.on("player_typing", (payload = {}, reply) => {
      try {
        const { room, player } = this.requirePlayer(socket, payload);
        if (room.state !== "playing") throw new Error("The match is not accepting words.");
        // Store each valid draft, but bound broadcasts with a trailing update
        // so a burst of packets cannot hide the player's final keystroke.
        const now = this.game.now();
        const game = room.finishWordGame;
        this.game.updateTyping(game, { playerId: player.id, text: payload.text, turnId: payload.turnId });
        const broadcast = () => {
          if (this.rooms[room.code] !== room || room.pausedAt || room.state !== "playing" || room.finishWordGame !== game || game.turnId !== payload.turnId || player.connected === false) return;
          player.lastTypingAt = this.game.now();
          this.io.to(room.code).emit("player_typing", { code: room.code, gameId: game.id, turnId: payload.turnId, playerId: player.id, text: game.typingText });
        };
        const elapsed = now - (player.lastTypingAt ?? -Infinity);
        if (elapsed < 25) {
          if (!this.typingTimers.has(room.code)) {
            const timer = setTimeout(() => { this.typingTimers.delete(room.code); broadcast(); }, 25 - elapsed);
            timer.unref(); this.typingTimers.set(room.code, timer);
          }
          if (typeof reply === "function") reply({ success: true, throttled: true });
          return;
        }
        this.clearTyping(room.code);
        broadcast();
        if (typeof reply === "function") reply({ success: true });
      } catch (error) { if (typeof reply === "function") reply({ success: false, message: error.message }); }
    });

    socket.on("submit_word", (payload = {}, reply) => {
      try {
        const { room, player } = this.requirePlayer(socket, payload);
        if (room.state !== "playing") throw new Error("The match is not accepting words.");
        const outcome = this.game.submit(room.finishWordGame, { playerId: player.id, word: payload.word, turnId: payload.turnId });
        if (typeof reply === "function") reply({ success: true, accepted: outcome.accepted,
          retryable: Boolean(outcome.retryable), reason: outcome.reason, message: outcome.message });
        this.resolve(room, outcome);
      } catch (error) { if (typeof reply === "function") reply({ success: false, message: error.message }); }
    });
  }
}

module.exports = { FinishWordRounds, FINISH_WORD_CHARACTERS };
