const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ColorCardRounds } = require("../src/socket/ColorCardSocket");
const { ColorCardGame } = require("../src/services/ColorCardGame");

function setup(t, count = 3) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const players = Array.from({ length: count }, (_, index) => ({ id: `player-${index}`, username: `Player ${index}` }));
  const room = { code: "VOTE", gameMode: "color-card", colorDuration: 30, colorCardCount: 2, players };
  const events = [];
  const manager = new ColorCardRounds({ rooms: { VOTE: room }, io: { to: (target) => ({ emit: (event, data) => events.push({ target, event, data }) }) }, publicPlayers: () => players, game: new ColorCardGame({ randomColor: () => "#123456" }) });
  const socket = (id) => { const client = new EventEmitter(); client.id = id; manager.register(client); return client; };
  const sockets = players.map((player) => socket(player.id));
  function act(index, event, changes = {}) {
    let response;
    (typeof index === "number" ? sockets[index] : index).emit(event, { code: room.code, roundId: room.colorRound.id, voteId: room.colorRound.skipVote?.id, hex: "#123456", ...changes }, (result) => { response = result; });
    return response;
  }
  manager.start(room);
  t.mock.timers.tick(5000);
  const submitAll = () => sockets.forEach((_, index) => assert.equal(act(index, "SUBMIT_COLOR").success, true));
  return { room, manager, events, sockets, act, submitAll, outsider: socket("outsider") };
}

test("all submissions open one shared vote lasting remaining time minus 10 seconds", (t) => {
  const { room, manager, events, act } = setup(t);
  act(0, "SUBMIT_COLOR"); act(1, "SUBMIT_COLOR");
  assert.equal(room.colorRound.skipVote, undefined);
  act(2, "SUBMIT_COLOR");
  const vote = manager.publicVote(room.colorRound);
  assert.equal(vote.endsAt - Date.now(), 20000);
  assert.equal(vote.requiredYes, 2);
  assert.equal(vote.totalPlayers, 3);
  assert.equal(room.colorRound.endsAt - vote.endsAt, 10000);
  assert.equal(events.filter((entry) => entry.event === "COLOR_SKIP_VOTE").length, 1);
});

test("a strict majority ends the card early and scores the latest submission time", (t) => {
  const { room, act, events } = setup(t);
  t.mock.timers.tick(2000); act(0, "SUBMIT_COLOR");
  t.mock.timers.tick(1000); act(1, "SUBMIT_COLOR");
  t.mock.timers.tick(3000); act(2, "SUBMIT_COLOR");
  t.mock.timers.tick(5000);
  assert.equal(act(0, "VOTE_COLOR_SKIP", { choice: "yes" }).success, true);
  assert.equal(room.state, "playing");
  assert.equal(act(1, "VOTE_COLOR_SKIP", { choice: "yes" }).success, true);
  assert.equal(room.state, "review");
  assert.equal(room.colorRound.result.reason, "vote");
  assert.deepEqual(room.colorRound.result.entries.map((entry) => entry.timeConsumedMs), [2000, 3000, 6000]);
  assert.ok(room.colorRound.result.entries.every((entry) => !entry.autoSubmitted));
  assert.equal(events.filter((entry) => entry.event === "ROUND_RESULTS").length, 3);
  t.mock.timers.tick(5000);
  assert.equal(room.state, "ranking");
  t.mock.timers.tick(10000);
  assert.equal(room.colorMatch.roundNumber, 2);
});

test("a tie never skips; a declined poll cannot be repeatedly reopened", (t) => {
  const { room, act, submitAll } = setup(t, 4);
  submitAll();
  act(0, "VOTE_COLOR_SKIP", { choice: "yes" });
  act(1, "VOTE_COLOR_SKIP", { choice: "yes" });
  assert.equal(room.state, "playing");
  act(2, "VOTE_COLOR_SKIP", { choice: "no" });
  act(3, "VOTE_COLOR_SKIP", { choice: "no" });
  assert.equal(room.colorRound.skipVote.status, "declined");
  const id = room.colorRound.skipVote.id;
  act(0, "EDIT_COLOR"); act(0, "SUBMIT_COLOR");
  assert.equal(room.colorRound.skipVote.id, id);
  assert.equal(room.colorRound.skipVote.status, "declined");
  t.mock.timers.tick(30000);
  assert.equal(room.colorRound.result.reason, "timeout");
});

test("an unanswered vote expires with 10 seconds left and normal play continues", (t) => {
  const { room, act, submitAll } = setup(t);
  submitAll(); act(0, "VOTE_COLOR_SKIP", { choice: "yes" });
  t.mock.timers.tick(20000);
  assert.equal(room.colorRound.skipVote.status, "expired");
  assert.equal(room.state, "playing");
  assert.equal(act(1, "VOTE_COLOR_SKIP", { choice: "yes" }).success, false);
  t.mock.timers.tick(9999); assert.equal(room.state, "playing");
  t.mock.timers.tick(1); assert.equal(room.state, "review");
});

test("editing cancels the poll; resubmitting starts a fresh poll without extending its deadline", (t) => {
  const { room, act, submitAll } = setup(t);
  submitAll();
  const previous = { ...room.colorRound.skipVote };
  act(0, "VOTE_COLOR_SKIP", { choice: "yes" });
  act(1, "EDIT_COLOR");
  assert.equal(room.colorRound.skipVote.status, "cancelled");
  assert.equal(room.colorRound.submittedAt.has("player-1"), false);
  t.mock.timers.tick(3000);
  act(1, "SUBMIT_COLOR");
  assert.notEqual(room.colorRound.skipVote.id, previous.id);
  assert.equal(room.colorRound.skipVote.endsAt, previous.endsAt);
  assert.equal(room.colorRound.skipVote.votes.size, 0);
  assert.equal(act(0, "VOTE_COLOR_SKIP", { voteId: previous.id, choice: "yes" }).success, false);
});

test("outsiders, stale rounds, invalid choices and duplicate votes cannot change the tally", (t) => {
  const { room, act, submitAll, outsider } = setup(t);
  submitAll();
  for (const [client, changes] of [[outsider, { choice: "yes" }], [0, { choice: "maybe" }], [0, { choice: true }], [0, { choice: "yes", roundId: "stale" }]]) {
    assert.equal(act(client, "VOTE_COLOR_SKIP", changes).success, false);
  }
  act(0, "VOTE_COLOR_SKIP", { choice: "yes" });
  assert.equal(act(0, "VOTE_COLOR_SKIP", { choice: "yes" }).success, false);
  assert.equal(act(0, "VOTE_COLOR_SKIP", { choice: "no" }).success, false);
  assert.equal(room.colorRound.skipVote.votes.size, 1);
});

test("no poll opens when less than 20 seconds remain, including after an edit", (t) => {
  const { room, submitAll } = setup(t);
  t.mock.timers.tick(10001);
  submitAll();
  assert.equal(room.colorRound.skipVote, undefined);
  t.mock.timers.tick(19999);
  assert.equal(room.state, "review");
});

test("a vote may open with exactly 20 seconds remaining but cannot restart below that threshold", (t) => {
  const { room, submitAll, act } = setup(t);
  t.mock.timers.tick(10000);
  submitAll();
  assert.equal(room.colorRound.skipVote.status, "active");
  assert.equal(room.colorRound.skipVote.endsAt - Date.now(), 10000);
  const voteId = room.colorRound.skipVote.id;
  act(0, "EDIT_COLOR");
  t.mock.timers.tick(1);
  act(0, "SUBMIT_COLOR");
  assert.equal(room.colorRound.skipVote.id, voteId);
  assert.equal(room.colorRound.skipVote.status, "cancelled");
});

test("waiting-room accuracy keeps the previous match until a new completed match replaces it", (t) => {
  const { room, manager, act } = setup(t);
  room.players.forEach((player) => { player.previousMatchAverageAccuracy = 88; player.previousMatchCardCount = 4; player.previousMatchId = "older-match"; });
  const expected = new Map(room.players.map((player) => [player.id, 0]));
  const complete = () => {
    manager.finish(room, "timeout");
    room.colorRound.result.entries.forEach((entry) => expected.set(entry.id, expected.get(entry.id) + entry.accuracy));
    manager.finish(room, "timeout");
  };
  complete();
  assert.ok(room.players.every((player) => player.previousMatchAverageAccuracy === 88));
  assert.ok(room.players.every((player) => player.previousMatchId === "older-match"));
  t.mock.timers.tick(15000);
  t.mock.timers.tick(5000);
  complete();
  room.players.forEach((player) => {
    assert.equal(player.previousMatchAverageAccuracy, expected.get(player.id) / 2);
    assert.equal(player.previousMatchCardCount, 2);
    assert.equal(player.previousMatchId, room.colorMatch.id);
  });
  t.mock.timers.tick(5000);
  assert.equal(room.state, "ended");
  const previousMatch = room.colorMatch.id;
  room.colorCardCount = 1;
  manager.start(room);
  t.mock.timers.tick(5000);
  assert.ok(room.players.every((player) => player.previousMatchId === previousMatch));
  room.players.forEach((player, index) => act(index, "UPDATE_COLOR_DRAFT", { hex: room.colorRound.targetColor }));
  complete();
  room.players.forEach((player) => {
    assert.equal(player.previousMatchAverageAccuracy, 100);
    assert.equal(player.previousMatchCardCount, 1);
    assert.equal(player.previousMatchId, room.colorMatch.id);
    assert.notEqual(player.previousMatchId, previousMatch);
  });
});

test("resetting previous-match accuracy clears every player's display without changing the active game", (t) => {
  const { room, manager } = setup(t);
  room.players.forEach((player) => { player.previousMatchAverageAccuracy = 90; player.previousMatchCardCount = 5; player.previousMatchId = "old"; });
  const activeRound = room.colorRound;
  const match = room.colorMatch;
  manager.resetPreviousMatch(room);
  assert.ok(room.players.every((player) => player.previousMatchAverageAccuracy === 0 && player.previousMatchCardCount === 0 && player.previousMatchId === null));
  assert.equal(room.state, "playing");
  assert.equal(room.colorRound, activeRound);
  assert.equal(room.colorMatch, match);
});

test("pausing preserves vote time, submitted colors and time consumed; snapshots keep colors private", (t) => {
  const { room, manager, act, submitAll } = setup(t);
  t.mock.timers.tick(2000);
  submitAll();
  const round = room.colorRound;
  const oldDeadline = round.skipVote.endsAt;
  assert.equal(manager.snapshot(room, "player-0").gameState.targetColor, null);
  assert.equal(manager.snapshot(room, "player-0").gameState.myDraft, "#123456");
  room.pausedAt = Date.now(); manager.clear(room.code);
  t.mock.timers.tick(30000);
  assert.equal(room.state, "playing");
  const duration = Date.now() - room.pausedAt; room.pausedAt = null;
  manager.resume(room, duration);
  assert.equal(round.skipVote.endsAt, oldDeadline + 30000);
  act(0, "VOTE_COLOR_SKIP", { choice: "yes" }); act(1, "VOTE_COLOR_SKIP", { choice: "yes" });
  assert.ok(round.result.entries.every((entry) => entry.timeConsumedMs === 2000));
  const review = manager.snapshot(room, "player-0").result;
  assert.equal(review.entries.length, 1);
  assert.deepEqual(review.winnerIds, []);
  assert.deepEqual(review.standings, []);
});
