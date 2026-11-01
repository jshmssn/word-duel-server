const { ColorCardGame, colorDuration, colorCardCount, MEMORIZE_DURATION_MS } = require("../services/ColorCardGame");
const RESULT_REVIEW_MS = 5_000;
const RANKING_MS = 10_000;

class ColorCardRounds {
  constructor({ io, rooms, publicPlayers, game = new ColorCardGame() }) {
    Object.assign(this, { io, rooms, publicPlayers, game });
    this.timers = new Map();
  }

  start(room) {
    room.colorMatch = this.game.createMatch(room.players, room.colorDuration, room.colorCardCount);
    this.startNext(room);
  }

  startNext(room) {
    this.clear(room.code);
    room.colorRound = this.game.startNext(room.colorMatch);
    room.state = "playing";
    room.players.forEach((player) => { player.ready = false; });
    const round = room.colorRound;
    this.io.to(room.code).emit("START_GAME", {
      code: room.code, gameMode: room.gameMode, maxPlayers: room.maxPlayers,
      creatorId: room.creatorId, matchId: room.colorMatch.id,
      serverNow: this.game.now(),
      roundNumber: room.colorMatch.roundNumber, totalRounds: room.colorMatch.targets.length,
      roundId: round.id, targetColor: round.targetColor, roundEndsAt: round.endsAt,
      phase: round.phase, memorizeEndsAt: round.memorizeEndsAt,
      memorizeDuration: MEMORIZE_DURATION_MS / 1000,
      roundDuration: round.durationSeconds, players: this.publicPlayers(room),
      submittedPlayerIds: [],
    });
    this.timers.set(room.code, {
      memorize: setTimeout(() => this.beginPicking(room, round.id), Math.max(0, round.memorizeEndsAt - this.game.now())),
      results: setTimeout(() => {
        if (room.colorRound === round) this.finish(room, "timeout");
      }, Math.max(0, round.endsAt - this.game.now())),
    });
  }

  beginPicking(room, roundId) {
    const round = room.colorRound;
    if (this.rooms[room.code] !== room || room.state !== "playing" || round?.id !== roundId || round.phase === "picking") return;
    round.phase = "picking";
    this.io.to(room.code).emit("COLOR_PICKING_STARTED", {
      code: room.code, roundId, phase: "picking", roundEndsAt: round.endsAt, serverNow: this.game.now(),
    });
  }

  finish(room, reason) {
    if (this.rooms[room.code] !== room || room.state !== "playing" || room.colorRound?.result) return;
    const result = this.game.finish(room.colorRound, reason);
    const matchState = this.game.recordResult(room.colorMatch, result);
    this.clear(room.code);
    room.state = "review";
    result.winnerIds.forEach((id) => {
      const player = room.players.find((candidate) => candidate.id === id);
      if (player) player.wins = (player.wins || 0) + 1;
    });
    const reviewEndsAt = this.game.now() + RESULT_REVIEW_MS;
    const rankingEndsAt = reviewEndsAt + RANKING_MS;
    room.colorRanking = { ...result, ...matchState, code: room.code, players: this.publicPlayers(room), rankingEndsAt };
    // Each player reviews their own answer first; rankings are revealed together.
    room.players.forEach((player) => this.io.to(player.id).emit("ROUND_RESULTS", {
      code: room.code, roundId: result.roundId, matchId: matchState.matchId,
      phase: "review", targetColor: result.targetColor, roundNumber: matchState.roundNumber,
      totalRounds: matchState.totalRounds, matchComplete: matchState.matchComplete,
      entries: result.entries.filter((entry) => entry.id === player.id),
      winners: [], winnerIds: [], standings: [], matchWinnerIds: [],
      players: this.publicPlayers(room), reason, reviewEndsAt, serverNow: this.game.now(),
    }));
    this.timers.set(room.code, {
      review: setTimeout(() => this.showRanking(room, result.roundId), RESULT_REVIEW_MS),
      next: matchState.matchComplete ? null : setTimeout(() => {
        if (this.rooms[room.code] === room && room.state === "ranking" && room.colorRound?.id === result.roundId) this.startNext(room);
      }, RESULT_REVIEW_MS + RANKING_MS),
    });
  }

  showRanking(room, roundId) {
    if (this.rooms[room.code] !== room || room.state !== "review" || room.colorRound?.id !== roundId) return;
    room.state = room.colorRanking.matchComplete ? "ended" : "ranking";
    this.io.to(room.code).emit("COLOR_RANKINGS", { ...room.colorRanking, phase: "ranking", serverNow: this.game.now() });
    if (room.state === "ended") this.clear(room.code);
  }

  clear(code) {
    const timers = this.timers.get(code);
    clearTimeout(timers?.memorize);
    clearTimeout(timers?.results);
    clearTimeout(timers?.review);
    clearTimeout(timers?.next);
    this.timers.delete(code);
  }

  register(socket) {
    socket.on("SET_COLOR_CARD_COUNT", (payload, reply) => {
      try {
        const room = this.rooms[payload?.code];
        if (!room || room.gameMode !== "color-card" || room.state !== "waiting" || room.creatorId !== socket.id) {
          throw new Error("Only the host can change the card count before a match.");
        }
        room.colorCardCount = colorCardCount(payload?.count);
        this.io.to(room.code).emit("COLOR_CARD_COUNT_UPDATED", { code: room.code, colorCardCount: room.colorCardCount });
        if (typeof reply === "function") reply({ success: true });
      } catch (error) {
        if (typeof reply === "function") reply({ success: false, message: error.message });
      }
    });

    socket.on("SET_COLOR_DURATION", (payload, reply) => {
      try {
        const room = this.rooms[payload?.code];
        if (!room || room.gameMode !== "color-card" || room.state !== "waiting" || room.creatorId !== socket.id) {
          throw new Error("Only the host can change the answer time before a match.");
        }
        room.colorDuration = colorDuration(payload?.duration);
        this.io.to(room.code).emit("COLOR_DURATION_UPDATED", { code: room.code, colorDuration: room.colorDuration });
        if (typeof reply === "function") reply({ success: true });
      } catch (error) {
        if (typeof reply === "function") reply({ success: false, message: error.message });
      }
    });

    const handleSelection = (action) => (payload = {}, reply) => {
      const respond = (response) => { if (typeof reply === "function") reply(response); };
      try {
        const { code, hex, roundId } = payload || {};
        const room = this.rooms[code];
        if (!room || room.gameMode !== "color-card" || room.state !== "playing") {
          throw new Error("There is no active Color Card round in this room.");
        }
        if (!room.players.some((player) => player.id === socket.id)) throw new Error("You are not in this room.");
        // Resolve an overdue round even if the event loop has delayed its timer.
        if (this.game.now() >= room.colorRound.endsAt) this.finish(room, "timeout");
        const color = this.game[action](room.colorRound, { playerId: socket.id, hex, roundId });
        this.beginPicking(room, roundId);
        respond({ success: true, hex: color, roundId });
        this.io.to(code).emit("SUBMISSION_UPDATE", {
          code, roundId, submittedPlayerIds: [...room.colorRound.submissions.keys()],
        });
        // Every player retains the full answer window, including after submitting.
      } catch (error) {
        respond({ success: false, message: error.message });
      }
    };
    socket.on("SUBMIT_COLOR", handleSelection("submit"));
    socket.on("UPDATE_COLOR_DRAFT", handleSelection("updateDraft"));
    socket.on("EDIT_COLOR", handleSelection("edit"));
  }
}

module.exports = { ColorCardRounds, RESULT_REVIEW_MS, RANKING_MS };
