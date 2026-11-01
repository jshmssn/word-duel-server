const test = require("node:test");
const assert = require("node:assert/strict");
const { io: client } = require("socket.io-client");
const { colorDistance } = require("../src/services/ColorCardGame");

process.env.WORD_CHAIN_DB_PATH = ":memory:";
const { server, io } = require("../index");
let url;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => io.close(resolve)); });

function next(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    function handler(data) { clearTimeout(timer); resolve(data); }
    socket.once(event, handler);
  });
}

async function connect(t) {
  const socket = client(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  t.after(() => socket.disconnect());
  await next(socket, "connect");
  return socket;
}

function ack(socket, event, data) {
  return socket.timeout(4000).emitWithAck(event, data);
}

async function makeRoom(t, count = 2, gameMode = "color-card", maxPlayers = count) {
  const host = await connect(t);
  const created = next(host, "room-created");
  host.emit("CREATE_ROOM", { username: "Host", gameMode, maxPlayers });
  const room = await created;
  const sockets = [host];
  for (let index = 1; index < count; index += 1) {
    const guest = await connect(t);
    const joined = next(guest, "room-joined");
    guest.emit("JOIN_ROOM", { code: room.code, username: `Guest ${index}` });
    await joined;
    sockets.push(guest);
  }
  return { ...room, sockets, host };
}

async function ready(room) {
  for (const socket of room.sockets) {
    const updated = next(room.host, "ready-update");
    socket.emit("toggle-ready", { code: room.code });
    await updated;
  }
}

async function startColor(room) {
  await ready(room);
  const started = next(room.host, "START_GAME");
  const picking = next(room.host, "COLOR_PICKING_STARTED", 7000);
  assert.equal((await ack(room.host, "START_GAME", { code: room.code })).success, true);
  const state = await started;
  await picking;
  return state;
}

test("room creation validates modes and limits; defaults retain Word Duel", async (t) => {
  const socket = await connect(t);
  for (const settings of [{ gameMode: "bogus" }, { maxPlayers: 9 }, { maxPlayers: 2.5 }]) {
    const response = await ack(socket, "CREATE_ROOM", { username: "Host", ...settings });
    assert.equal(response.success, false);
  }
  const created = next(socket, "room-created");
  socket.emit("create-room", { username: "Legacy host" });
  const state = await created;
  assert.equal(state.gameMode, "word-duel");
  assert.equal(state.maxPlayers, 2);
});

test("the server rejects excess and duplicate players in both modes", async (t) => {
  for (const mode of ["word-duel", "color-card"]) {
    const room = await makeRoom(t, 3, mode, 3);
    const outsider = await connect(t);
    const rejected = next(outsider, "join-error");
    outsider.emit("JOIN_ROOM", { code: room.code, username: "Extra" });
    assert.equal((await rejected).message, "Room is full.");
    const duplicate = next(room.host, "join-error");
    room.host.emit("JOIN_ROOM", { code: room.code, username: "Again" });
    assert.match((await duplicate).message, /already in a room/);
  }
});

test("Color Card shares targets and lets every player edit after everyone submits", async (t) => {
  const room = await makeRoom(t, 3);
  const outsider = await connect(t);
  await ready(room);
  const starts = room.sockets.map((socket) => next(socket, "START_GAME"));
  const picking = next(room.host, "COLOR_PICKING_STARTED", 7000);
  await ack(room.host, "START_GAME", { code: room.code });
  const states = await Promise.all(starts);
  const state = states[0];
  assert.ok(states.every((item) => item.targetColor === state.targetColor && item.roundId === state.roundId && item.serverNow === state.serverNow && item.roundEndsAt === state.roundEndsAt));
  assert.equal(state.totalRounds, 5);
  assert.equal(Object.hasOwn(state, "targets"), false);
  const payload = { code: room.code, roundId: state.roundId, hex: state.targetColor };
  assert.equal((await ack(room.host, "SUBMIT_COLOR", payload)).success, false);
  await picking;
  assert.equal((await ack(outsider, "UPDATE_COLOR_DRAFT", payload)).success, false);
  assert.equal((await ack(room.host, "SUBMIT_COLOR", { ...payload, roundId: "stale" })).success, false);
  assert.equal((await ack(room.host, "SUBMIT_COLOR", { ...payload, hex: "#BAD" })).success, false);
  for (const socket of room.sockets) assert.equal((await ack(socket, "SUBMIT_COLOR", payload)).success, true);
  // All answers are in, but every player still has time to revise.
  for (const socket of room.sockets) {
    assert.equal((await ack(socket, "EDIT_COLOR", payload)).success, true);
    assert.equal((await ack(socket, "UPDATE_COLOR_DRAFT", { ...payload, hex: "#112233" })).success, true);
    assert.equal((await ack(socket, "SUBMIT_COLOR", { ...payload, hex: "#112233" })).success, true);
  }
});

test("Color Card cancels its timer and returns players to the lobby on disconnect", async (t) => {
  const room = await makeRoom(t, 3);
  await startColor(room);
  const lobby = next(room.sockets[1], "rematch-lobby");
  room.host.disconnect();
  const state = await lobby;
  assert.equal(state.creatorId, room.sockets[1].id);
  assert.equal(state.players.length, 2);
  assert.ok(state.players.every((player) => !player.ready));
  assert.match(state.message, /cancelled/);
});

test("readying Color Card starts its round automatically without word category roulette", { timeout: 12000 }, async (t) => {
  const room = await makeRoom(t, 2, "color-card", 8);
  let categoryEvents = 0;
  room.host.on("category-selected", () => { categoryEvents += 1; });
  const started = next(room.host, "START_GAME", 10000);
  await ready(room);
  const state = await started;
  assert.equal(state.gameMode, "color-card");
  assert.equal(state.players.length, 2);
  assert.equal(categoryEvents, 0);
});

test("the server finalizes everyone, reviews for 5 seconds, ranks for 10, then advances", { timeout: 60000 }, async (t) => {
  const room = await makeRoom(t);
  const state = await startColor(room);
  const reviews = room.sockets.map((socket) => next(socket, "ROUND_RESULTS", 32000));
  const rankings = room.sockets.map((socket) => next(socket, "COLOR_RANKINGS", 38000));
  const nextCards = room.sockets.map((socket) => next(socket, "START_GAME", 48000));
  const payload = { code: room.code, roundId: state.roundId, hex: state.targetColor };
  await ack(room.host, "SUBMIT_COLOR", payload);
  await ack(room.host, "EDIT_COLOR", payload);
  await ack(room.host, "UPDATE_COLOR_DRAFT", { ...payload, hex: "#223344" });
  await ack(room.sockets[1], "UPDATE_COLOR_DRAFT", { ...payload, hex: "#112233" });
  const results = await Promise.all(reviews);
  for (let index = 0; index < results.length; index += 1) {
    assert.equal(results[index].phase, "review");
    assert.equal(results[index].reason, "timeout");
    assert.equal(results[index].entries.length, 1);
    assert.equal(results[index].entries[0].id, room.sockets[index].id);
    assert.equal(results[index].entries[0].submittedColor, index ? "#112233" : "#223344");
    assert.equal(results[index].entries[0].autoSubmitted, true);
    assert.deepEqual(results[index].winnerIds, []);
  }
  assert.equal((await ack(room.host, "EDIT_COLOR", payload)).success, false);
  const ranked = await Promise.all(rankings);
  assert.deepEqual(ranked[0], ranked[1]);
  assert.equal(ranked[0].phase, "ranking");
  assert.equal(ranked[0].entries.length, 2);
  assert.ok(ranked[0].entries[0].distance <= ranked[0].entries[1].distance);
  const nextStates = await Promise.all(nextCards);
  assert.ok(nextStates.every((card) => card.roundNumber === 2 && card.targetColor === nextStates[0].targetColor && card.memorizeEndsAt === nextStates[0].memorizeEndsAt));
  assert.notEqual(nextStates[0].targetColor, state.targetColor);
});

test("only the Color Card host can set a 30, 45 or 60 second shared answer timer", async (t) => {
  const room = await makeRoom(t);
  assert.equal((await ack(room.sockets[1], "SET_COLOR_DURATION", { code: room.code, duration: 45 })).success, false);
  assert.equal((await ack(room.host, "SET_COLOR_DURATION", { code: room.code, duration: 15 })).success, false);
  assert.equal((await ack(room.sockets[1], "SET_COLOR_CARD_COUNT", { code: room.code, count: 3 })).success, false);
  assert.equal((await ack(room.host, "SET_COLOR_CARD_COUNT", { code: room.code, count: 101 })).success, false);
  const counts = room.sockets.map((socket) => next(socket, "COLOR_CARD_COUNT_UPDATED"));
  assert.equal((await ack(room.host, "SET_COLOR_CARD_COUNT", { code: room.code, count: 7 })).success, true);
  assert.ok((await Promise.all(counts)).every((value) => value.colorCardCount === 7));
  for (const duration of [30, 45, 60]) {
    const updates = room.sockets.map((socket) => next(socket, "COLOR_DURATION_UPDATED"));
    assert.equal((await ack(room.host, "SET_COLOR_DURATION", { code: room.code, duration })).success, true);
    const values = await Promise.all(updates);
    assert.ok(values.every((value) => value.colorDuration === duration));
  }
  const state = await startColor(room);
  assert.equal(state.roundDuration, 60);
  assert.equal(state.totalRounds, 7);
  assert.equal(state.roundEndsAt - state.memorizeEndsAt, 60000);
  assert.equal((await ack(room.host, "SET_COLOR_DURATION", { code: room.code, duration: 30 })).success, false);
  assert.equal((await ack(room.host, "SET_COLOR_CARD_COUNT", { code: room.code, count: 3 })).success, false);
});

for (const count of [2, 8]) {
  test(`Word Duel with ${count} players keeps its deduction rules and rotates every seat`, async (t) => {
    const room = await makeRoom(t, count, "word-duel");
    await ready(room);
    const category = next(room.host, "category-selected");
    await ack(room.host, "START_GAME", { code: room.code });
    assert.ok((await category).category);
    const starts = room.sockets.map((socket) => next(socket, "game-start"));
    room.sockets.forEach((socket) => socket.emit("slot-machine-done", { code: room.code }));
    const states = await Promise.all(starts);
    for (let index = 0; index < count; index += 1) {
      assert.equal(states[index].opponentId, room.sockets[(index + 1) % count].id);
      assert.equal(states[index].players.length, count);
      assert.ok(states[index].myWord);
      assert.equal(states[index].opponentLetterCount, states[(index + 1) % count].myWordLetterCount);
    }
    let currentTurn = states[0].currentTurn;
    const originalTurn = currentTurn;
    const visited = new Set();
    for (let turn = 0; turn < count; turn += 1) {
      visited.add(currentTurn);
      const socket = room.sockets.find((player) => player.id === currentTurn);
      const changed = next(room.host, "turn-change");
      socket.emit("guess-word", { code: room.code, guess: "not-a-dictionary-word-ever" });
      const newTurn = (await changed).currentTurn;
      const currentIndex = room.sockets.indexOf(socket);
      assert.equal(newTurn, room.sockets[(currentIndex + 1) % count].id);
      currentTurn = newTurn;
    }
    assert.equal(visited.size, count);
    assert.equal(currentTurn, originalTurn);

    const askerIndex = room.sockets.findIndex((socket) => socket.id === currentTurn);
    const asker = room.sockets[askerIndex];
    const target = room.sockets[(askerIndex + 1) % count];
    const prompt = next(target, "letter-ask-prompt");
    asker.emit("ask-letter", { code: room.code, letter: "A" });
    assert.equal((await prompt).letter, "A");
    if (count > 2) {
      // A different participant must not consume the pending question.
      room.sockets[(askerIndex + 2) % count].emit("answer-letter-ask", { code: room.code, answer: true });
    }
    const answered = next(room.host, "letter-result");
    const turnChanged = next(room.host, "turn-change");
    target.emit("answer-letter-ask", { code: room.code, answer: true });
    assert.equal((await answered).askerId, asker.id);
    currentTurn = (await turnChanged).currentTurn;
    const winner = room.sockets.find((socket) => socket.id === currentTurn);
    const winnerIndex = room.sockets.indexOf(winner);
    const targetIndex = (winnerIndex + 1) % count;
    const ended = next(room.host, "game-over");
    winner.emit("guess-word", { code: room.code, guess: states[targetIndex].myWord });
    const result = await ended;
    assert.equal(result.winnerId, winner.id);
    assert.equal(result.players.length, count);
    assert.equal(result.opponentsByPlayer[winner.id], room.sockets[targetIndex].id);
  });
}
