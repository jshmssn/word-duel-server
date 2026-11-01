function lobbyPlayerId(socket) { return socket.data?.playerId || socket.id; }
const { ColorCardGame, colorDuration, colorCardCount, MEMORIZE_DURATION_MS } = require("../services/ColorCardGame");
const { randomUUID } = require("node:crypto");
const RESULT_REVIEW_MS = 5_000;
const RANKING_MS = 10_000;
const VOTE_RESERVE_MS = 10_000;
const MIN_VOTE_REMAINING_MS = 20_000;

class ColorCardRounds {
  constructor({ io, rooms, publicPlayers, game = new ColorCardGame() }) {
    Object.assign(this, { io, rooms, publicPlayers, game });
    this.timers = new Map();
  }

  start(room) {
    room.colorMatch = this.game.createMatch(room.players, room.colorDuration, room.colorCardCount);
    this.startNext(room);
  }

  resetPreviousMatch(room) {
    if (room.gameMode !== "color-card") return;
    room.players.forEach((player) => {
      player.previousMatchAverageAccuracy = 0;
      player.previousMatchCardCount = 0;
      player.previousMatchId = null;
    });
  }

  startNext(room) {
    this.clear(room.code);
    room.colorRound = this.game.startNext(room.colorMatch);
    room.state = "playing";
    room.players.forEach((player) => { player.ready = false; });
    const round = room.colorRound;
    this.io.to(room.code).emit("START_GAME", this.gameState(room));
    this.schedule(room);
  }

  gameState(room, playerId) {
    const round = room.colorRound;
    return {
      code: room.code, gameMode: room.gameMode, maxPlayers: room.maxPlayers,
      creatorId: room.creatorId, matchId: room.colorMatch.id,
      serverNow: this.game.now(),
      roundNumber: room.colorMatch.roundNumber, totalRounds: room.colorMatch.targets.length,
      roundId: round.id, targetColor: round.phase === "memorizing" ? round.targetColor : null, roundEndsAt: round.endsAt,
      phase: round.phase, memorizeEndsAt: round.memorizeEndsAt,
      memorizeDuration: MEMORIZE_DURATION_MS / 1000,
      roundDuration: round.durationSeconds, players: this.publicPlayers(room),
      submittedPlayerIds: [...round.submissions.keys()], skipVote: this.publicVote(round),
      ...(playerId ? { myDraft: round.drafts.get(playerId) } : {}),
    };
  }

  snapshot(room, playerId) {
    if (room.state === "playing") return { gameState: this.gameState(room, playerId) };
    const reviewing = room.state === "review";
    const result = { ...room.colorRanking, phase: reviewing ? "review" : "ranking", serverNow: this.game.now(), reviewEndsAt: room.colorReviewEndsAt };
    if (reviewing) Object.assign(result, {
      entries: result.entries.filter((entry) => entry.id === playerId),
      winners: [], winnerIds: [], standings: [], matchWinnerIds: [],
    });
    return { result };
  }

  schedule(room) {
    this.clear(room.code);
    const round = room.colorRound;
    const timers = {};
    const after = (deadline, action) => setTimeout(() => {
      if (this.rooms[room.code] === room && !room.pausedAt && room.colorRound === round) action();
    }, Math.max(0, deadline - this.game.now()));
    if (room.state === "playing") {
      if (round.phase === "memorizing") timers.memorize = after(round.memorizeEndsAt, () => this.beginPicking(room, round.id));
      timers.results = after(round.endsAt, () => this.finish(room, "timeout"));
      if (round.skipVote?.status === "active") timers.vote = after(round.skipVote.endsAt, () => this.closeVote(room, "expired"));
    } else {
      if (room.state === "review") timers.review = after(room.colorReviewEndsAt, () => this.showRanking(room, round.id));
      if (["review", "ranking"].includes(room.state) && !room.colorRanking.matchComplete) timers.next = after(room.colorRanking.rankingEndsAt, () => this.startNext(room));
    }
    this.timers.set(room.code, timers);
  }

  resume(room, pauseDuration) {
    if (room.state === "playing") {
      const round = room.colorRound;
      round.memorizeEndsAt += pauseDuration;
      round.endsAt += pauseDuration;
      round.submittedAt.forEach((time, id) => round.submittedAt.set(id, time + pauseDuration));
      if (round.skipVote?.status === "active") round.skipVote.endsAt += pauseDuration;
    }
    if (room.colorReviewEndsAt) room.colorReviewEndsAt += pauseDuration;
    if (room.colorRanking) room.colorRanking.rankingEndsAt += pauseDuration;
    this.schedule(room);
  }

  beginPicking(room, roundId) {
    const round = room.colorRound;
    if (this.rooms[room.code] !== room || room.state !== "playing" || round?.id !== roundId || round.phase === "picking") return;
    round.phase = "picking";
    this.io.to(room.code).emit("COLOR_PICKING_STARTED", {
      code: room.code, roundId, phase: "picking", roundEndsAt: round.endsAt, serverNow: this.game.now(),
    });
  }

  publicVote(round) {
    const vote = round.skipVote;
    return vote ? {
      id: vote.id, status: vote.status, endsAt: vote.endsAt,
      totalPlayers: round.players.length,
      requiredYes: Math.floor(round.players.length / 2) + 1,
      yesPlayerIds: [...vote.votes].filter(([, choice]) => choice === "yes").map(([id]) => id),
      noPlayerIds: [...vote.votes].filter(([, choice]) => choice === "no").map(([id]) => id),
    } : null;
  }

  publishVote(room) {
    this.io.to(room.code).emit("COLOR_SKIP_VOTE", {
      code: room.code, roundId: room.colorRound.id,
      vote: this.publicVote(room.colorRound), serverNow: this.game.now(),
    });
  }

  closeVote(room, status) {
    const vote = room.colorRound?.skipVote;
    if (vote?.status !== "active") return;
    clearTimeout(this.timers.get(room.code)?.vote);
    vote.status = status;
    this.publishVote(room);
    if (status === "passed") this.finish(room, "vote");
  }

  syncVote(room) {
    const round = room.colorRound;
    if (this.rooms[room.code] !== room || room.state !== "playing" || round?.result) return;
    const everyoneSubmitted = round.players.every((player) => round.submissions.has(player.id));
    if (!everyoneSubmitted) {
      this.closeVote(room, "cancelled");
      return;
    }
    // A declined/expired poll is final for this card. Editing can cancel a poll,
    // but resubmission never extends its original deadline (round end minus 10s).
    if (round.skipVote && round.skipVote.status !== "cancelled") return;
    if (round.endsAt - this.game.now() < MIN_VOTE_REMAINING_MS) return;
    const endsAt = round.endsAt - VOTE_RESERVE_MS;
    if (this.game.now() >= endsAt) return;
    round.skipVote = { id: randomUUID(), status: "active", endsAt, votes: new Map() };
    const timers = this.timers.get(room.code);
    timers.vote = setTimeout(() => {
      if (this.rooms[room.code] === room && room.state === "playing" && room.colorRound === round) this.closeVote(room, "expired");
    }, endsAt - this.game.now());
    this.publishVote(room);
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
    if (matchState.matchComplete) {
      matchState.standings.forEach((standing) => {
        const player = room.players.find((candidate) => candidate.id === standing.id);
        if (!player) return;
        player.previousMatchAverageAccuracy = standing.averageAccuracy;
        player.previousMatchCardCount = matchState.totalRounds;
        player.previousMatchId = matchState.matchId;
      });
    }
    const reviewEndsAt = this.game.now() + RESULT_REVIEW_MS;
    room.colorReviewEndsAt = reviewEndsAt;
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
    this.schedule(room);
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
    clearTimeout(timers?.vote);
    this.timers.delete(code);
  }

  register(socket) {
    socket.on("VOTE_COLOR_SKIP", (payload = {}, reply) => {
      const respond = (response) => { if (typeof reply === "function") reply(response); };
      try {
        const { code, roundId, voteId, choice } = payload || {};
        const room = this.rooms[code];
        const round = room?.colorRound;
        if (!room || room.gameMode !== "color-card" || room.state !== "playing" || !round || round.id !== roundId) throw new Error("That vote belongs to an inactive round.");
        if (!room.players.some((player) => player.id === lobbyPlayerId(socket))) throw new Error("You are not in this room.");
        const vote = round.skipVote;
        if (!vote || vote.id !== voteId || vote.status !== "active") throw new Error("This vote is no longer open.");
        if (this.game.now() >= round.endsAt) { this.finish(room, "timeout"); throw new Error("The round has ended."); }
        if (this.game.now() >= vote.endsAt) { this.closeVote(room, "expired"); throw new Error("Voting time has ended."); }
        if (!["yes", "no"].includes(choice)) throw new Error("Choose Yes or No.");
        if (vote.votes.has(lobbyPlayerId(socket))) throw new Error("Your vote has already been counted.");
        vote.votes.set(lobbyPlayerId(socket), choice);
        const { yesPlayerIds, noPlayerIds, requiredYes, totalPlayers } = this.publicVote(round);
        respond({ success: true, choice, voteId });
        if (yesPlayerIds.length >= requiredYes) this.closeVote(room, "passed");
        else if (totalPlayers - noPlayerIds.length < requiredYes) this.closeVote(room, "declined");
        else this.publishVote(room);
      } catch (error) { respond({ success: false, message: error.message }); }
    });

    socket.on("SET_COLOR_CARD_COUNT", (payload, reply) => {
      try {
        const room = this.rooms[payload?.code];
        if (!room || room.gameMode !== "color-card" || room.state !== "waiting" || room.creatorId !== lobbyPlayerId(socket)) {
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
        if (!room || room.gameMode !== "color-card" || room.state !== "waiting" || room.creatorId !== lobbyPlayerId(socket)) {
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
        if (!room.players.some((player) => player.id === lobbyPlayerId(socket))) throw new Error("You are not in this room.");
        // Resolve an overdue round even if the event loop has delayed its timer.
        if (this.game.now() >= room.colorRound.endsAt) this.finish(room, "timeout");
        const color = this.game[action](room.colorRound, { playerId: lobbyPlayerId(socket), hex, roundId });
        this.beginPicking(room, roundId);
        respond({ success: true, hex: color, roundId });
        this.io.to(code).emit("SUBMISSION_UPDATE", {
          code, roundId, submittedPlayerIds: [...room.colorRound.submissions.keys()],
        });
        if (action !== "updateDraft") this.io.to(code).emit("COLOR_PLAYER_ACTION", {
          code, roundId, playerId: lobbyPlayerId(socket),
          username: room.players.find((player) => player.id === lobbyPlayerId(socket)).username,
          action: action === "submit" ? "submitted" : "editing",
        });
        this.syncVote(room);
      } catch (error) {
        respond({ success: false, message: error.message });
      }
    };
    socket.on("SUBMIT_COLOR", handleSelection("submit"));
    socket.on("UPDATE_COLOR_DRAFT", handleSelection("updateDraft"));
    socket.on("EDIT_COLOR", handleSelection("edit"));
  }
}

module.exports = { ColorCardRounds, RESULT_REVIEW_MS, RANKING_MS, VOTE_RESERVE_MS, MIN_VOTE_REMAINING_MS };
