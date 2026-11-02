const { randomInt, randomUUID } = require("node:crypto");

const STARTING_LIVES = 3;
const TURN_DURATION_SECONDS = 15;
const HARD_MODE_AFTER = 10;
const MAX_WORD_LENGTH = 64;

// The transport owns room membership, pause state and scheduling. This engine
// owns every rule and deadline, so a client can never award itself a word/life.
class FinishWordGame {
  constructor({ isValidWord, now = Date.now, randomLetter = () => String.fromCharCode(97 + randomInt(26)), randomPlayerIndex = randomInt, getStartingPrefixes } = {}) {
    if (typeof isValidWord !== "function") throw new TypeError("Provide an SQLite-backed isValidWord function.");
    Object.assign(this, { isValidWord, now, randomLetter, randomPlayerIndex, getStartingPrefixes });
  }

  start(players, { turnDuration = TURN_DURATION_SECONDS, hardModeAfter = HARD_MODE_AFTER } = {}) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 8) throw new Error("Finish the Word needs 2 to 8 players.");
    if (players.some((player) => !player?.id) || new Set(players.map((player) => player.id)).size !== players.length) throw new Error("Every player needs a unique ID.");
    if (!Number.isInteger(turnDuration) || turnDuration < 1 || turnDuration > 120) throw new Error("Choose a turn duration from 1 to 120 seconds.");
    if (!Number.isInteger(hardModeAfter) || hardModeAfter < 1 || hardModeAfter > 1000) throw new Error("Choose a hard-mode threshold from 1 to 1000 accepted words.");
    const letter = String(this.randomLetter()).toLowerCase();
    if (!/^[a-z]$/.test(letter)) throw new Error("The starting letter must be a single English letter.");
    const firstPlayer = this.randomPlayerIndex(players.length);
    if (!Number.isInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= players.length) throw new Error("Choose a valid starting player.");
    const game = {
      id: randomUUID(), status: "PLAYING",
      players: players.map((player) => {
        const name = String(player.username || player.name || "Player").trim().slice(0, 24) || "Player";
        return { id: player.id, username: name, name, characterId: player.characterId || null, lives: STARTING_LIVES, isAlive: true };
      }),
      currentTurnIndex: firstPlayer, turnId: null, turnDuration, turnEndsAt: null,
      lastWord: null, requiredPrefix: letter, usedWordsSet: new Set(),
      successfulTurns: 0, hardModeAfter, typingText: "", history: [], failedPlayerIds: new Set(),
      winnerId: null, winnerName: null,
    };
    this.beginTurn(game);
    return game;
  }

  publicState(game) {
    return {
      gameMode: "finish-word", gameId: game.id, status: game.status,
      players: game.players.map((player) => ({ ...player })),
      currentTurnIndex: game.currentTurnIndex,
      currentPlayerId: game.status === "PLAYING" ? game.players[game.currentTurnIndex]?.id || null : null,
      turnId: game.turnId, turnDuration: game.turnDuration, turnEndsAt: game.turnEndsAt,
      serverNow: this.now(), lastWord: game.lastWord, requiredPrefix: game.requiredPrefix,
      usedWords: [...game.usedWordsSet], successfulTurns: game.successfulTurns,
      hardMode: game.successfulTurns >= game.hardModeAfter, hardModeAfter: game.hardModeAfter,
      typingText: game.typingText, history: game.history.map((entry) => ({ ...entry })),
      winnerId: game.winnerId, winnerName: game.winnerName,
    };
  }

  requireTurn(game, playerId, turnId) {
    if (!game || game.status !== "PLAYING") throw new Error("This match has ended.");
    const player = game.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("You are not in this match.");
    if (!player.isAlive) throw new Error("You have been eliminated. Watch the remaining players.");
    if (game.players[game.currentTurnIndex]?.id !== playerId) throw new Error("Wait for your turn.");
    if (typeof turnId !== "string" || turnId !== game.turnId) throw new Error("That action belongs to an earlier turn.");
    return player;
  }

  submit(game, { playerId, word: submittedWord, turnId } = {}) {
    const player = this.requireTurn(game, playerId, turnId);
    // The deadline wins a race with any delayed client packet or timer callback.
    if (this.now() >= game.turnEndsAt) return this.expire(game, turnId);
    const word = typeof submittedWord === "string" ? submittedWord.replace(/\s/g, "").toLowerCase() : "";
    let reason, message;
    if (word.length < 2) {
      reason = "too_short"; message = "Use a word with at least 2 letters.";
    } else if (word.length > MAX_WORD_LENGTH || !/^[a-z]+$/.test(word)) {
      reason = "invalid_format"; message = `Use only English letters, up to ${MAX_WORD_LENGTH} characters.`;
    } else if (!word.startsWith(game.requiredPrefix)) {
      reason = "wrong_prefix"; message = `Your word must start with ${game.requiredPrefix.toUpperCase()}.`;
    } else if (game.usedWordsSet.has(word)) {
      reason = "already_used"; message = "That word has already been used in this match.";
    } else if (this.isValidWord(word) !== true) {
      reason = "not_in_dictionary"; message = "That word is not in the dictionary.";
    }
    // A rejected attempt leaves the turn and its original deadline intact.
    // Only running out of time costs a life.
    if (reason) {
      game.typingText = "";
      return { accepted: false, retryable: true, reason, message,
        word: word.slice(0, MAX_WORD_LENGTH), playerId: player.id,
        eliminatedPlayerIds: [], gameOver: false };
    }

    const requiredPrefix = game.requiredPrefix;
    game.usedWordsSet.add(word);
    game.lastWord = word;
    game.successfulTurns += 1;
    game.failedPlayerIds.clear();
    game.requiredPrefix = word.slice(game.successfulTurns >= game.hardModeAfter ? -2 : -1);
    const outcome = { accepted: true, reason: "accepted", message: `${player.username} played ${word.toUpperCase()}.`, word,
      playerId, eliminatedPlayerIds: [], gameOver: false };
    this.record(game, player, outcome, requiredPrefix);
    this.advanceTurn(game);
    return outcome;
  }

  expire(game, turnId) {
    if (!game || game.status !== "PLAYING" || turnId !== game.turnId || this.now() < game.turnEndsAt) return null;
    return this.loseLife(game, game.players[game.currentTurnIndex], {
      reason: "timeout", message: "Time is up. You lost a life.", word: null,
    });
  }

  updateTyping(game, { playerId, text, turnId } = {}) {
    this.requireTurn(game, playerId, turnId);
    if (this.now() >= game.turnEndsAt) throw new Error("Your turn has expired.");
    if (typeof text !== "string") throw new Error("Typing text must be a string.");
    game.typingText = text.replace(/[^a-z]/gi, "").slice(0, MAX_WORD_LENGTH);
    return game.typingText;
  }

  resume(game, pauseDuration) {
    if (!Number.isFinite(pauseDuration) || pauseDuration < 0) throw new Error("Pause duration must be a nonnegative number.");
    if (game.status === "PLAYING") game.turnEndsAt += pauseDuration;
  }

  removePlayer(game, playerId) {
    const index = game.players.findIndex((player) => player.id === playerId);
    if (index < 0) return null;
    const activeId = game.players[game.currentTurnIndex]?.id;
    const [player] = game.players.splice(index, 1);
    const outcome = { accepted: false, reason: "removed", message: `${player.username} left the match.`, word: null,
      playerId, eliminatedPlayerIds: player.isAlive ? [playerId] : [], gameOver: false };
    if (this.finishIfWinner(game)) outcome.gameOver = true;
    else if (game.status === "PLAYING") {
      if (activeId === playerId) {
        game.currentTurnIndex = (index - 1 + game.players.length) % game.players.length;
        this.advanceTurn(game);
      } else game.currentTurnIndex = game.players.findIndex((candidate) => candidate.id === activeId);
    }
    return outcome;
  }

  loseLife(game, player, { reason, message, word }) {
    player.lives = Math.max(0, player.lives - 1);
    player.isAlive = player.lives > 0;
    const outcome = { accepted: false, reason, message, word, playerId: player.id,
      eliminatedPlayerIds: player.isAlive ? [] : [player.id], gameOver: false };
    this.record(game, player, outcome, game.requiredPrefix);
    if (this.finishIfWinner(game)) outcome.gameOver = true;
    else {
      game.failedPlayerIds.add(player.id);
      if (game.players.filter((candidate) => candidate.isAlive).every((candidate) => game.failedPlayerIds.has(candidate.id))) {
        const length = game.successfulTurns >= game.hardModeAfter ? 2 : 1;
        const choices = this.getStartingPrefixes?.(length).filter((prefix) => prefix !== game.requiredPrefix);
        let prefix = choices?.length ? choices[randomInt(choices.length)] : Array.from({ length }, () => this.randomLetter()).join("").toLowerCase();
        if (prefix === game.requiredPrefix) prefix = prefix.slice(0, -1) + String.fromCharCode(97 + (prefix.charCodeAt(length - 1) - 96) % 26);
        game.requiredPrefix = prefix;
        game.lastWord = null;
        game.failedPlayerIds.clear();
        outcome.prefixChanged = true;
        outcome.message += ` Nobody found a word. Start with ${prefix.toUpperCase()} now.`;
      }
      this.advanceTurn(game);
    }
    return outcome;
  }

  record(game, player, outcome, requiredPrefix) {
    game.history.push({ id: randomUUID(), playerId: player.id, username: player.username, word: outcome.word,
      accepted: outcome.accepted, reason: outcome.reason, message: outcome.message,
      lives: player.lives, requiredPrefix, at: this.now() });
    game.history = game.history.slice(-200);
  }

  finishIfWinner(game) {
    const remaining = game.players.filter((player) => player.isAlive);
    if (remaining.length > 1) return false;
    game.status = "ENDED";
    game.winnerId = remaining[0]?.id || null;
    game.winnerName = remaining[0]?.username || null;
    game.currentTurnIndex = -1;
    game.turnId = null; game.turnEndsAt = null; game.typingText = "";
    return true;
  }

  beginTurn(game) {
    game.turnId = randomUUID();
    game.turnEndsAt = this.now() + game.turnDuration * 1000;
    game.typingText = "";
  }

  advanceTurn(game) {
    for (let offset = 1; offset <= game.players.length; offset++) {
      const index = (game.currentTurnIndex + offset) % game.players.length;
      if (!game.players[index].isAlive) continue;
      game.currentTurnIndex = index;
      this.beginTurn(game);
      return;
    }
    this.finishIfWinner(game);
  }
}

module.exports = { FinishWordGame, STARTING_LIVES, TURN_DURATION_SECONDS, HARD_MODE_AFTER, MAX_WORD_LENGTH };
