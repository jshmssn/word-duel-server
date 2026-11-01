const test = require("node:test");
const assert = require("node:assert/strict");
const { io: client } = require("socket.io-client");
process.env.WORD_CHAIN_DB_PATH = ":memory:";
process.env.RECONNECT_GRACE_MS = "600";
const { server, io } = require("../index");
let url;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => io.close(resolve)); });

function next(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`No ${event}`)); }, timeout);
    function listener(data) { clearTimeout(timer); resolve(data); }
    socket.once(event, listener);
  });
}
async function connect(t) {
  const socket = client(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  socket.on("room-session", (session) => { socket.session = session; });
  t.after(() => socket.disconnect());
  await next(socket, "connect");
  return socket;
}
const ack = (socket, event, payload) => socket.timeout(4000).emitWithAck(event, payload);
async function roomFor(t, gameMode) {
  const host = await connect(t), guest = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode, colorCardCount: 2 });
  const joined = next(guest, "room-joined");
  guest.emit("join-room", { code: room.code, username: "Guest" }); await joined;
  for (const socket of [host, guest]) {
    const ready = next(host, "ready-update"); socket.emit("toggle-ready", { code: room.code }); await ready;
  }
  const started = next(host, gameMode === "color-card" ? "START_GAME" : "category-selected");
  await ack(host, "START_GAME", { code: room.code }); await started;
  if (gameMode === "word-duel") {
    const states = [next(host, "game-start"), next(guest, "game-start")];
    host.emit("slot-machine-done", { code: room.code }); guest.emit("slot-machine-done", { code: room.code });
    return { room, host, guest, states: await Promise.all(states) };
  }
  return { room, host, guest };
}

for (const mode of ["word-duel", "color-card"]) {
  test(`${mode}: a transport interruption reserves the original seat and pauses everyone`, async (t) => {
    const { room, host, guest, states } = await roomFor(t, mode);
    const session = host.session;
    assert.ok(session.token);
    const paused = next(guest, "ROOM_PAUSED");
    host.io.engine.close();
    const presence = await paused;
    assert.equal(presence.players.length, 2);
    assert.equal(presence.players.find((player) => player.id === session.playerId).connected, false);
    const action = await ack(guest, "VOTE_COLOR_SKIP", { code: room.code, choice: "yes" });
    assert.equal(action.success, false);
    assert.match(action.message, /paused/);
    const recovered = await connect(t);
    const restored = next(recovered, "room-restored");
    const resumed = next(guest, "ROOM_RESUMED");
    assert.equal((await ack(recovered, "resume-room", session)).success, true);
    const snapshot = await restored; await resumed;
    assert.notEqual(recovered.id, session.playerId);
    assert.equal(snapshot.playerId, session.playerId);
    assert.equal(snapshot.creatorId, session.playerId);
    assert.equal(snapshot.screen, "game");
    assert.equal(snapshot.pausedAt, null);
    assert.equal(snapshot.players.length, 2);
    assert.ok(snapshot.players.every((player) => player.connected));
    assert.equal(JSON.stringify(snapshot).includes(session.token), false);
    if (mode === "word-duel") assert.equal(snapshot.gameState.myWord, states[0].myWord);
    const message = next(guest, "chat-message");
    recovered.emit("chat-message", { code: room.code, text: "Back again" });
    assert.equal((await message).playerId, session.playerId);
    assert.equal((await ack(recovered, "leave-room", { code: room.code })).success, true);
  });
}

test("a browser app switch pauses immediately, and resuming the same connection restores the round", async (t) => {
  const { room, host, guest } = await roomFor(t, "color-card");
  const paused = next(guest, "ROOM_PAUSED");
  host.emit("suspend-room", { code: room.code }); await paused;
  const restored = next(host, "room-restored");
  assert.equal((await ack(host, "resume-room", host.session)).success, true);
  const state = await restored;
  assert.equal(state.gameState.phase, "memorizing");
  assert.equal(state.gameState.roundEndsAt - state.gameState.memorizeEndsAt, 30000);
  assert.equal(state.players.length, 2);
});

test("pending Word Duel questions remain answerable after reconnecting to a new socket", async (t) => {
  const { room, host, guest, states } = await roomFor(t, "word-duel");
  const asker = states[0].currentTurn === host.id ? host : guest;
  const responder = asker === host ? guest : host;
  const question = next(responder, "letter-ask-prompt");
  asker.emit("ask-letter", { code: room.code, letter: "A" }); await question;
  const session = responder.session;
  const paused = next(asker, "ROOM_PAUSED"); responder.io.engine.close(); await paused;
  const recovered = await connect(t);
  const restored = next(recovered, "room-restored");
  await ack(recovered, "resume-room", session);
  assert.equal((await restored).gameState.letterAskPrompt.letter, "A");
  const answered = next(asker, "letter-result");
  recovered.emit("answer-letter-ask", { code: room.code, answer: true });
  assert.equal((await answered).askerId, asker.id);
});

test("expired seats cancel the round for everyone; invalid or expired credentials cannot rejoin", async (t) => {
  const { room, host, guest } = await roomFor(t, "color-card");
  const session = host.session;
  const paused = next(guest, "ROOM_PAUSED");
  const lobby = next(guest, "rematch-lobby");
  host.io.engine.close(); await paused;
  const state = await lobby;
  assert.equal(state.players.length, 1);
  assert.equal(state.creatorId, guest.id);
  const outsider = await connect(t);
  assert.equal((await ack(outsider, "resume-room", { ...session, token: "wrong" })).success, false);
  assert.equal((await ack(outsider, "resume-room", session)).success, false);
});
