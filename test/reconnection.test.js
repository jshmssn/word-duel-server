const test = require("node:test");
const assert = require("node:assert/strict");
const { io: client } = require("socket.io-client");
process.env.WORD_CHAIN_DB_PATH = ":memory:";
process.env.RECONNECT_GRACE_MS = "600";
process.env.RECONNECT_KICK_DELAY_MS = "150";
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
async function connect(t, options = {}) {
  const socket = client(url, { transports: ["websocket"], forceNew: true, reconnection: false, ...options });
  socket.on("room-session", (session) => { socket.session = session; });
  if (options.auth?.session) socket.restoration = next(socket, "room-restored");
  t.after(() => socket.disconnect());
  const connected = next(socket, "connect");
  if (options.autoConnect === false) socket.connect();
  await connected;
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

for (const gameMode of ["word-duel", "color-card"]) {
  test(`${gameMode}: rooms stay available when all connected players switch apps`, async (t) => {
    const { room, host, guest } = await roomFor(t, gameMode);
    const hostPaused = next(guest, "ROOM_PAUSED");
    host.emit("suspend-room", { code: room.code }); await hostPaused;
    const guestPaused = next(host, "ROOM_PAUSED");
    guest.emit("suspend-room", { code: room.code }); await guestPaused;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const hostRestored = next(host, "room-restored");
    assert.equal((await ack(host, "resume-room", host.session)).success, true);
    assert.equal((await hostRestored).players.length, 2);
    const guestRestored = next(guest, "room-restored");
    assert.equal((await ack(guest, "resume-room", guest.session)).success, true);
    const state = await guestRestored;
    assert.equal(state.screen, "game");
    assert.equal(state.pausedAt, null);
    assert.ok(state.players.every((player) => player.connected));
  });
}

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

test("waiting seats remain reserved past the old expiry while another player stays connected", async (t) => {
  const host = await connect(t), guest = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode: "color-card" });
  const joined = next(guest, "room-joined");
  guest.emit("join-room", { code: room.code, username: "Guest" }); await joined;
  const session = host.session;
  let pauseCount = 0;
  let departures = 0;
  guest.on("ROOM_PAUSED", () => pauseCount++);
  guest.on("player-left", () => departures++);
  const presence = next(guest, "ready-update");
  host.io.engine.close();
  assert.equal((await presence).players.find((player) => player.id === session.playerId).connectionStatus, "reconnecting");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(pauseCount, 0);
  assert.equal(departures, 0);
  const outsider = await connect(t);
  assert.equal((await ack(outsider, "resume-room", { ...session, token: "wrong" })).success, false);
  const restored = next(outsider, "room-restored");
  assert.equal((await ack(outsider, "resume-room", session)).success, true);
  const state = await restored;
  assert.equal(state.pausedAt, null);
  assert.equal(state.players.length, 2);
  assert.equal(state.creatorId, session.playerId);
  assert.ok(state.players.every((player) => player.connected));
});

for (const gameMode of ["word-duel", "color-card", "finish-word"]) {
  test(`${gameMode}: a connected waiting room survives idle time and app switches`, async (t) => {
    const host = await connect(t);
    const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode });
    host.emit("suspend-room", { code: room.code });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const restored = next(host, "room-restored");
    assert.equal((await ack(host, "resume-room", host.session)).success, true);
    const snapshot = await restored;
    assert.equal(snapshot.screen, "waiting");
    assert.equal(snapshot.players.length, 1);
    assert.equal(snapshot.players[0].connected, true);
    const guest = await connect(t);
    const joined = await ack(guest, "JOIN_ROOM", { code: room.code, username: "Guest" });
    assert.equal(joined.success, true);
    assert.equal(joined.players.length, 2);
    assert.equal(joined.creatorId, host.session.playerId);
  });

  test(`${gameMode}: a room expires after every player disconnects`, async (t) => {
    const host = await connect(t), guest = await connect(t);
    const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode });
    await ack(guest, "JOIN_ROOM", { code: room.code, username: "Guest" });
    const session = host.session;
    host.disconnect();
    guest.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const outsider = await connect(t);
    assert.equal((await ack(outsider, "resume-room", session)).success, false);
    const joined = await ack(outsider, "JOIN_ROOM", { code: room.code, username: "New player" });
    assert.equal(joined.success, false);
    assert.equal(joined.message, "Room not found.");
  });
}

test("empty-room cleanup starts at the last disconnect and is cancelled by a returning player", async (t) => {
  const host = await connect(t), guest = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode: "color-card" });
  await ack(guest, "JOIN_ROOM", { code: room.code, username: "Guest" });
  const session = host.session;
  const presence = next(guest, "ready-update");
  host.disconnect(); await presence;
  await new Promise((resolve) => setTimeout(resolve, 400));
  guest.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recovered = await connect(t);
  assert.equal((await ack(recovered, "resume-room", session)).success, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((await ack(recovered, "resume-room", session)).success, true);
  recovered.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 650));
  const outsider = await connect(t);
  const joined = await ack(outsider, "JOIN_ROOM", { code: room.code, username: "New player" });
  assert.equal(joined.message, "Room not found.");
});

test("quitting the last connected player starts cleanup even when disconnected seats remain", async (t) => {
  const host = await connect(t), guest = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode: "color-card" });
  await ack(guest, "JOIN_ROOM", { code: room.code, username: "Guest" });
  const presence = next(host, "ready-update");
  guest.disconnect(); await presence;
  assert.equal((await ack(host, "leave-room", { code: room.code })).success, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const outsider = await connect(t);
  const joined = await ack(outsider, "JOIN_ROOM", { code: room.code, username: "New player" });
  assert.equal(joined.message, "Room not found.");
});

test("handshake credentials restore the same seat in a full lobby across repeated app switches", async (t) => {
  let host = await connect(t);
  const guest = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host" });
  const session = host.session;
  const joined = next(guest, "room-joined");
  guest.emit("join-room", { code: room.code, username: "Guest" }); await joined;
  for (let index = 0; index < 3; index++) {
    const presence = next(guest, "ready-update");
    host.io.engine.close(); await presence;
    // Register the snapshot listener before opening the transport.
    host = await connect(t, { auth: { session }, autoConnect: false });
    const snapshot = await host.restoration;
    assert.equal(snapshot.players.length, 2);
    assert.equal(snapshot.playerId, session.playerId);
    assert.equal(snapshot.creatorId, session.playerId);
    assert.ok(snapshot.players.every((player) => player.connected));
    assert.notEqual(host.id, session.playerId);
  }
});

test("an authenticated join restores a reserved slot before the room-full check", async (t) => {
  const { room, host, guest } = await roomFor(t, "color-card");
  const session = host.session;
  const paused = next(guest, "ROOM_PAUSED");
  host.disconnect(); await paused;
  const recovered = await connect(t);
  const restored = next(recovered, "room-restored");
  recovered.emit("JOIN_ROOM", { code: room.code, username: "Host", session });
  const state = await restored;
  assert.equal(state.players.length, 2);
  assert.equal(state.playerId, session.playerId);
  assert.equal(state.screen, "game");
});

async function kickRoom(t, gameMode, count = 4) {
  const host = await connect(t);
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode, maxPlayers: count });
  const sockets = [host];
  for (let index = 1; index < count; index++) {
    const socket = await connect(t);
    const joined = next(socket, "room-joined");
    socket.emit("JOIN_ROOM", { code: room.code, username: `Player ${index}` }); await joined;
    sockets.push(socket);
  }
  if (gameMode === "finish-word") {
    const characters = ["knight", "wizard", "ninja", "robot", "alien", "pirate", "astronaut", "dino"];
    for (const [index, socket] of sockets.entries()) {
      assert.equal((await ack(socket, "select_character", { code: room.code, characterId: characters[index] })).success, true);
    }
  }
  for (const socket of sockets) {
    const ready = next(host, "ready-update"); socket.emit("toggle-ready", { code: room.code }); await ready;
  }
  const started = next(host, gameMode === "color-card" ? "START_GAME" : gameMode === "finish-word" ? "turn_start" : "category-selected");
  await ack(host, "START_GAME", { code: room.code });
  let state = await started;
  if (gameMode === "word-duel") {
    const playing = next(host, "game-start");
    for (const socket of sockets) socket.emit("slot-machine-done", { code: room.code });
    state = await playing;
  }
  return { room, sockets, state };
}

function openKickVote(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("ROOM_KICK_VOTES", listen); reject(new Error("No kick vote")); }, 4000);
    function listen(data) {
      if (!data.kickVotes.length) return;
      clearTimeout(timer); socket.off("ROOM_KICK_VOTES", listen); resolve(data.kickVotes[0]);
    }
    socket.on("ROOM_KICK_VOTES", listen);
  });
}

for (const gameMode of ["color-card", "word-duel"]) {
  test(`${gameMode}: kick voting waits for eligibility, requires an active majority and continues the same game`, async (t) => {
    const { room, sockets, state } = await kickRoom(t, gameMode);
    const [target, first, second, third] = sockets;
    const session = target.session;
    const paused = next(first, "ROOM_PAUSED"), opened = openKickVote(first);
    target.emit("suspend-room", { code: room.code });
    const pause = await paused;
    assert.equal(pause.players.filter((player) => player.connected).length, 3);
    assert.equal(pause.kickVotes.length, 0);
    const payload = { code: room.code, playerId: session.playerId, choice: "yes" };
    assert.equal((await ack(first, "VOTE_ROOM_KICK", { ...payload, voteId: "early" })).success, false);
    const vote = await opened;
    assert.equal(vote.totalPlayers, 3); assert.equal(vote.requiredYes, 2);
    payload.voteId = vote.id;
    assert.equal((await ack(target, "VOTE_ROOM_KICK", payload)).success, false);
    const outsider = await connect(t);
    assert.equal((await ack(outsider, "VOTE_ROOM_KICK", payload)).success, false);
    const tally = next(third, "ROOM_KICK_VOTES");
    assert.equal((await ack(first, "VOTE_ROOM_KICK", payload)).success, true);
    assert.equal((await tally).kickVotes[0].yesPlayerIds.length, 1);
    assert.equal((await ack(first, "VOTE_ROOM_KICK", payload)).success, false);
    const restored = next(third, "room-restored"), resumed = next(third, "ROOM_RESUMED");
    assert.equal((await ack(second, "VOTE_ROOM_KICK", payload)).success, true);
    await resumed;
    const snapshot = await restored;
    assert.equal(snapshot.screen, "game"); assert.equal(snapshot.pausedAt, null);
    assert.equal(snapshot.players.length, 3); assert.ok(snapshot.players.every((player) => player.connected));
    assert.equal(snapshot.creatorId, first.session.playerId);
    if (gameMode === "color-card") {
      assert.equal(snapshot.gameState.roundId, state.roundId);
      assert.equal(snapshot.gameState.matchId, state.matchId);
    } else {
      assert.equal(snapshot.gameState.category, state.category);
      assert.notEqual(snapshot.gameState.currentTurn, session.playerId);
    }
    assert.equal((await ack(target, "resume-room", session)).success, false);
  });
}

test("returning after a kick vote opens cancels the vote and preserves the session beyond the waiting-room expiry", async (t) => {
  const { room, host, guest } = await roomFor(t, "color-card");
  const opened = openKickVote(guest);
  host.emit("suspend-room", { code: room.code });
  const vote = await opened;
  await new Promise((resolve) => setTimeout(resolve, 650));
  const restored = next(host, "room-restored");
  assert.equal((await ack(host, "resume-room", host.session)).success, true);
  assert.equal((await restored).kickVotes.length, 0);
  assert.equal((await ack(guest, "VOTE_ROOM_KICK", { code: room.code, playerId: host.session.playerId, voteId: vote.id, choice: "yes" })).success, false);
});

for (const gameMode of ["color-card", "word-duel", "finish-word"]) {
  test(`${gameMode}: kicking the last opponent returns the remaining player to the waiting room`, async (t) => {
    const { room, sockets, state } = await kickRoom(t, gameMode, 2);
    const [target, active] = sockets;
    const kickedSession = target.session;
    const victories = [];
    active.on("game-over", (result) => victories.push(result));
    active.on("game_over", (result) => victories.push(result));
    const opened = openKickVote(active);
    target.disconnect();
    const vote = await opened;
    assert.equal(vote.requiredYes, 1);
    const lobby = next(active, "rematch-lobby");
    const restored = next(active, "room-restored");
    assert.equal((await ack(active, "VOTE_ROOM_KICK", { code: room.code, playerId: kickedSession.playerId, voteId: vote.id, choice: "yes" })).success, true);
    assert.equal((await lobby).departure, true);
    const snapshot = await restored;
    assert.equal(snapshot.pausedAt, null);
    assert.equal(snapshot.screen, "waiting");
    assert.equal(snapshot.code, room.code);
    assert.equal(snapshot.creatorId, active.session.playerId);
    assert.equal(snapshot.players.length, 1);
    assert.equal(snapshot.players[0].ready, false);
    assert.equal(snapshot.players[0].wins, 0);
    assert.deepEqual(snapshot.kickVotes, []);
    assert.equal(snapshot.gameState, undefined);
    assert.equal(snapshot.result, undefined);
    assert.deepEqual(victories, []);
    const newcomer = await connect(t);
    assert.equal((await ack(newcomer, "resume-room", kickedSession)).success, false);
    const joined = await ack(newcomer, "JOIN_ROOM", { code: room.code, username: "New opponent" });
    assert.equal(joined.success, true);
    assert.equal(joined.players.length, 2);
    if (gameMode === "color-card") {
      for (const socket of [active, newcomer]) assert.equal((await ack(socket, "toggle-ready", { code: room.code })).success, true);
      const started = next(active, "START_GAME");
      assert.equal((await ack(active, "START_GAME", { code: room.code })).success, true);
      const fresh = await started;
      assert.notEqual(fresh.roundId, state.roundId);
      assert.notEqual(fresh.matchId, state.matchId);
      assert.equal(fresh.roundNumber, 1);
    }
  });
}

test("multiple reconnecting players have separate votes and the game stays paused until both are resolved", async (t) => {
  const { room, sockets } = await kickRoom(t, "color-card");
  const [firstTarget, firstVoter, secondVoter, secondTarget] = sockets;
  const opened = new Promise((resolve) => {
    function listen(data) {
      if (data.kickVotes.length !== 2) return;
      firstVoter.off("ROOM_KICK_VOTES", listen); resolve(data.kickVotes);
    }
    firstVoter.on("ROOM_KICK_VOTES", listen);
  });
  firstTarget.emit("suspend-room", { code: room.code });
  secondTarget.emit("suspend-room", { code: room.code });
  const votes = await opened;
  let resumed = 0;
  firstVoter.on("ROOM_RESUMED", () => resumed++);
  for (const [index, vote] of votes.entries()) {
    assert.equal(vote.requiredYes, 2);
    const payload = { code: room.code, playerId: vote.playerId, voteId: vote.id, choice: "yes" };
    await ack(firstVoter, "VOTE_ROOM_KICK", payload);
    const restored = next(firstVoter, "room-restored");
    await ack(secondVoter, "VOTE_ROOM_KICK", payload);
    const snapshot = await restored;
    assert.equal(Boolean(snapshot.pausedAt), index === 0);
    assert.equal(resumed, index);
  }
});
