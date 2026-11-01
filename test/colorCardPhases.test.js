const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ColorCardGame } = require("../src/services/ColorCardGame");
const { ColorCardRounds } = require("../src/socket/ColorCardSocket");

test("automatic phases keep all players on each unique card and stop at the configured count", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const events = [];
  const players = [{ id: "host", username: "Host" }, { id: "guest", username: "Guest" }];
  const room = { code: "TEST", creatorId: "host", gameMode: "color-card", colorDuration: 30, colorCardCount: 3, players };
  const rooms = { TEST: room };
  const io = { to: (target) => ({ emit: (event, data) => events.push({ target, event, data }) }) };
  const manager = new ColorCardRounds({ io, rooms, publicPlayers: (room) => room.players, game: new ColorCardGame({ randomColor: () => "#A34F2E" }) });
  const sockets = players.map((player) => { const socket = new EventEmitter(); socket.id = player.id; manager.register(socket); return socket; });
  const act = (socket, event, hex) => {
    let reply;
    socket.emit(event, { code: room.code, roundId: room.colorRound.id, hex }, (response) => { reply = response; });
    assert.equal(reply?.success, true, reply?.message);
  };
  manager.start(room);
  for (let card = 1; card <= 3; card += 1) {
    const round = room.colorRound;
    assert.equal(room.colorMatch.roundNumber, card);
    t.mock.timers.tick(5000);
    sockets.forEach((socket) => act(socket, "SUBMIT_COLOR", round.targetColor));
    assert.equal(room.state, "playing", "all early submissions retain the full answer window");
    sockets.forEach((socket) => {
      act(socket, "EDIT_COLOR");
      act(socket, "UPDATE_COLOR_DRAFT", round.targetColor);
    });
    t.mock.timers.tick(29999);
    assert.equal(room.state, "playing");
    t.mock.timers.tick(1);
    assert.equal(room.state, "review");
    const reviews = events.filter((entry) => entry.event === "ROUND_RESULTS" && entry.data.roundId === round.id);
    assert.equal(reviews.length, players.length);
    reviews.forEach((entry) => {
      assert.equal(entry.data.entries.length, 1);
      assert.equal(entry.data.entries[0].id, entry.target);
      assert.equal(entry.data.entries[0].autoSubmitted, true);
      assert.equal(entry.data.entries[0].accuracy, 100);
    });
    t.mock.timers.tick(4999);
    assert.equal(room.state, "review");
    t.mock.timers.tick(1);
    const ranking = events.filter((entry) => entry.event === "COLOR_RANKINGS").at(-1).data;
    assert.equal(ranking.entries.length, 2);
    assert.equal(ranking.totalRounds, 3);
    if (card < 3) {
      assert.equal(room.state, "ranking");
      t.mock.timers.tick(9999);
      assert.equal(room.colorRound.id, round.id);
      t.mock.timers.tick(1);
      assert.notEqual(room.colorRound.id, round.id);
    } else {
      assert.equal(room.state, "ended");
      assert.equal(ranking.matchComplete, true);
      assert.deepEqual(ranking.matchWinnerIds, ["host", "guest"]);
      assert.equal(manager.timers.size, 0);
    }
  }
  t.mock.timers.tick(600000);
  const starts = events.filter((entry) => entry.event === "START_GAME");
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map((entry) => entry.data.targetColor)).size, 3);
});

test("clearing a cancelled match removes review, ranking and next-card timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const events = [];
  const room = { code: "TEST", gameMode: "color-card", colorDuration: 30, colorCardCount: 2, players: [{ id: "one", username: "One" }] };
  const manager = new ColorCardRounds({ rooms: { TEST: room }, io: { to: () => ({ emit: (event) => events.push(event) }) }, publicPlayers: () => room.players });
  manager.start(room);
  t.mock.timers.tick(35000);
  assert.equal(room.state, "review");
  manager.clear(room.code);
  t.mock.timers.tick(60000);
  assert.equal(events.filter((event) => event === "START_GAME").length, 1);
  assert.equal(events.includes("COLOR_RANKINGS"), false);
});
