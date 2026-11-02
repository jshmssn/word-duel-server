const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io: client } = require("socket.io-client");

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "finish-word-integration-"));
const sourcePath = path.join(fixtureDirectory, "clean-words.txt");
const dictionary = ["apple", "banana", "carrot", "dog", "elephant", "frog", "goat", "horse", "igloo", "jam", "kite", "lion", "monkey", "night", "orange", "pig", "queen", "rabbit", "snake", "turtle", "umbrella", "van", "whale", "xylophone", "yak", "zebra"];
fs.writeFileSync(sourcePath, dictionary.join("\n"));
process.env.WORD_CHAIN_DB_PATH = ":memory:";
process.env.FINISH_WORD_DB_PATH = ":memory:";
process.env.FINISH_WORDS_FILE = sourcePath;
process.env.RECONNECT_GRACE_MS = "1000";
process.env.RECONNECT_KICK_DELAY_MS = "120";
const { server, io } = require("../index");
let url;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => io.close(resolve));
  fs.unlinkSync(sourcePath); fs.rmdirSync(fixtureDirectory);
});

function next(socket, event, { timeout = 4000, accepts = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listen); reject(new Error(`No ${event}`)); }, timeout);
    function listen(data) {
      if (!accepts(data)) return;
      clearTimeout(timer); socket.off(event, listen); resolve(data);
    }
    socket.on(event, listen);
  });
}
async function connect(t, options = {}) {
  const socket = client(url, { transports: ["websocket"], forceNew: true, reconnection: false, autoConnect: false, ...options });
  socket.on("room-session", (session) => { socket.session = session; });
  if (options.auth?.session) socket.restoration = next(socket, "room-restored");
  t.after(() => socket.disconnect());
  const connected = next(socket, "connect"); socket.connect(); await connected;
  return socket;
}
const ack = (socket, event, payload) => socket.timeout(4000).emitWithAck(event, payload);
async function makeRoom(t, { count = 2, start = true } = {}) {
  const host = await connect(t), sockets = [host];
  const room = await ack(host, "CREATE_ROOM", { username: "Host", gameMode: "finish-word", maxPlayers: count });
  assert.equal(room.success, true);
  for (let index = 1; index < count; index++) {
    const socket = await connect(t);
    const joined = await ack(socket, "join_room", { roomId: room.code, name: `Player ${index}` });
    assert.equal(joined.success, true); sockets.push(socket);
  }
  if (!start) return { room, sockets, host };
  for (const [index, socket] of sockets.entries()) assert.equal((await ack(socket, "select_character", { roomId: room.code, characterId: ["knight", "wizard", "ninja", "robot"][index] })).success, true);
  for (const socket of sockets) assert.equal((await ack(socket, "toggle-ready", { code: room.code })).ready, true);
  const started = next(host, "turn_start");
  assert.equal((await ack(host, "start_game", { roomId: room.code })).success, true);
  return { room, sockets, host, state: await started };
}

test("character ownership, explicit ready toggles and host-only ready starts work on real sockets", async (t) => {
  const { room, sockets, host } = await makeRoom(t, { start: false });
  const guest = sockets[1], outsider = await connect(t);
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).success, false, "choose a character before readying up");
  assert.equal((await ack(outsider, "toggle-ready", { code: room.code })).success, false);
  assert.equal((await ack(host, "start_game", { roomId: room.code })).success, false, "every player must choose a character first");
  const simultaneous = await Promise.all(sockets.map((socket) => ack(socket, "select_character", { roomId: room.code, characterId: "knight" })));
  assert.equal(simultaneous.filter((response) => response.success).length, 1);
  const losingIndex = simultaneous.findIndex((response) => !response.success);
  const chosen = await ack(sockets[losingIndex], "select_character", { code: room.code, characterId: "wizard" });
  assert.equal(chosen.success, true); assert.equal(new Set(chosen.players.map((player) => player.characterId)).size, 2);
  assert.ok(chosen.players.every((player) => !player.ready), "character selection does not ready players");
  assert.equal((await ack(host, "start_game", { code: room.code })).success, false);
  const readyUpdate = next(guest, "ready-update");
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).ready, true);
  const readyState = await readyUpdate;
  assert.equal(readyState.changedPlayerId, host.session.playerId);
  assert.equal(readyState.players.find((player) => player.id === host.session.playerId).ready, true);
  assert.equal((await ack(host, "start_game", { code: room.code })).success, false, "every player must be ready");
  assert.equal((await ack(guest, "toggle-ready", { code: room.code })).ready, true);
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).ready, false);
  assert.equal((await ack(host, "start_game", { code: room.code })).success, false, "unreadying blocks start");
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).ready, true);
  assert.equal((await ack(host, "select_character", { code: room.code, characterId: "robot" })).success, true);
  assert.equal((await ack(host, "start_game", { code: room.code })).success, false, "changing character clears readiness");
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).ready, true);
  assert.equal((await ack(guest, "start_game", { roomId: room.code })).success, false);
  assert.equal((await ack(outsider, "join_room", { roomId: room.code, name: "Extra" })).success, false);
  const turn = next(host, "turn_start");
  assert.equal((await ack(host, "start_game", { roomId: room.code })).success, true);
  assert.equal((await turn).players.length, 2);
  assert.equal((await ack(host, "select_character", { roomId: room.code, characterId: "dino" })).success, false);
  assert.equal((await ack(host, "toggle-ready", { code: room.code })).success, false);
});

test("real typing and word submissions validate the SQLite source and broadcast one authoritative next turn", async (t) => {
  const { room, sockets, state } = await makeRoom(t);
  const host = sockets.find((socket) => socket.session.playerId === state.currentPlayerId);
  const guest = sockets.find((socket) => socket !== host);
  const word = dictionary.find((candidate) => candidate.startsWith(state.requiredPrefix));
  assert.ok(word);
  const typing = next(guest, "player_typing");
  assert.equal((await ack(host, "player_typing", { roomId: room.code, turnId: state.turnId, text: word.slice(0, 3) })).success, true);
  assert.equal((await typing).text, word.slice(0, 3));
  assert.equal((await ack(guest, "submit_word", { roomId: room.code, turnId: state.turnId, word })).success, false);
  const accepted = next(guest, "word_accepted"), nextTurn = next(guest, "turn_start");
  const response = await ack(host, "submit_word", { roomId: room.code, turnId: state.turnId, word: ` \t${word.toUpperCase().split("").join(" ")}\n` });
  assert.equal(response.success, true); assert.equal(response.accepted, true);
  assert.equal((await accepted).word, word);
  const following = await nextTurn;
  assert.equal(following.currentPlayerId, guest.session.playerId);
  assert.equal(following.requiredPrefix, word.slice(-1)); assert.deepEqual(following.usedWords, [word]);
  assert.equal(following.typingText, ""); assert.ok(following.players.every((player) => player.lives === 3));
  assert.equal((await ack(host, "submit_word", { roomId: room.code, turnId: state.turnId, word })).success, false);
  const rejected = next(host, "word_rejected");
  const failure = await ack(guest, "submit_word", { roomId: room.code, turnId: following.turnId, word: `${following.requiredPrefix}zzzzzzz` });
  assert.equal(failure.success, true); assert.equal(failure.accepted, false);
  assert.equal(failure.retryable, true);
  const rejection = await rejected;
  assert.equal(rejection.reason, "not_in_dictionary"); assert.equal(rejection.turnId, following.turnId);
  const nextWord = dictionary.find((candidate) => candidate.startsWith(following.requiredPrefix));
  const afterRetry = next(host, "turn_start");
  assert.equal((await ack(guest, "submit_word", { code: room.code, turnId: following.turnId, word: nextWord })).accepted, true);
  const remaining = await afterRetry;
  assert.equal(remaining.players.find((player) => player.id === guest.session.playerId).lives, 3);
  assert.equal(remaining.currentPlayerId, host.session.playerId);
  assert.deepEqual(remaining.usedWords, [word, nextWord]);
});

test("readiness automatically starts the shared countdown and unreadying or switching characters cancels it", { timeout: 20000 }, async (t) => {
  const { room, sockets, host } = await makeRoom(t, { start: false });
  const guest = sockets[1];
  for (const [index, socket] of sockets.entries()) {
    await ack(socket, "select_character", { code: room.code, characterId: index ? "wizard" : "knight" });
    await ack(socket, "toggle-ready", { code: room.code });
  }
  const firstCountdown = await next(host, "countdown");
  assert.equal(firstCountdown.count, 5);
  const cancelled = next(host, "countdown-cancel");
  assert.equal((await ack(guest, "toggle-ready", { code: room.code })).ready, false);
  await cancelled;
  assert.equal((await ack(guest, "toggle-ready", { code: room.code })).ready, true);
  assert.equal((await next(host, "countdown")).count, 5);
  const changedCharacter = next(host, "countdown-cancel");
  const switched = await ack(guest, "select_character", { code: room.code, characterId: "ninja" });
  assert.equal(switched.players.find((player) => player.id === guest.session.playerId).ready, false);
  await changedCharacter;
  const autoStarted = next(host, "turn_start", { timeout: 10000 });
  await ack(guest, "toggle-ready", { code: room.code });
  const state = await autoStarted;
  assert.equal(state.turnDuration, 15);
  assert.ok(state.players.some((player) => player.id === state.currentPlayerId));
  assert.equal(state.players.find((player) => player.id === guest.session.playerId).characterId, "ninja");
});

test("a real 15-second server deadline rejects an unanswered turn without any client timer event", { timeout: 20000 }, async (t) => {
  const { sockets, host, state } = await makeRoom(t);
  const rejected = next(host, "word_rejected", { timeout: 18000 }), nextTurn = next(host, "turn_start", { timeout: 18000 });
  assert.equal(state.turnDuration, 15);
  const failure = await rejected;
  assert.equal(failure.reason, "timeout"); assert.equal(failure.playerId, state.currentPlayerId);
  const following = await nextTurn;
  assert.equal(following.currentPlayerId, sockets[(state.currentTurnIndex + 1) % sockets.length].session.playerId);
  assert.equal(following.players.find((player) => player.id === state.currentPlayerId).lives, 2);
  assert.notEqual(following.turnId, state.turnId);
});

test("a transport replacement restores its character, lives, typing and turn in a full active room", async (t) => {
  const { room, sockets, state } = await makeRoom(t);
  const host = sockets.find((socket) => socket.session.playerId === state.currentPlayerId);
  const guest = sockets.find((socket) => socket !== host), session = host.session;
  await ack(host, "player_typing", { code: room.code, turnId: state.turnId, text: state.requiredPrefix.toUpperCase() });
  const paused = next(guest, "ROOM_PAUSED"); host.io.engine.close(); await paused;
  assert.equal((await ack(guest, "submit_word", { code: room.code, turnId: state.turnId, word: "apple" })).success, false);
  const resumed = next(guest, "ROOM_RESUMED");
  const recovered = await connect(t, { auth: { session } });
  const snapshot = await recovered.restoration; await resumed;
  assert.notEqual(recovered.id, session.playerId); assert.equal(snapshot.playerId, session.playerId);
  assert.equal(snapshot.players.length, 2); assert.equal(snapshot.screen, "game"); assert.equal(snapshot.pausedAt, null);
  assert.equal(snapshot.gameState.gameId, state.gameId); assert.equal(snapshot.gameState.turnId, state.turnId);
  assert.equal(snapshot.gameState.typingText, state.requiredPrefix.toUpperCase());
  assert.equal(snapshot.gameState.players.find((player) => player.id === session.playerId).characterId, state.players[state.currentTurnIndex].characterId);
  assert.ok(snapshot.gameState.players.every((player) => player.lives === 3));
});

test("an active reconnecting player can be kicked by a majority and the next player gets 15 seconds", async (t) => {
  const { room, sockets, state } = await makeRoom(t, { count: 3 });
  const [host, first, second] = [...sockets.slice(state.currentTurnIndex), ...sockets.slice(0, state.currentTurnIndex)];
  const opened = next(first, "ROOM_KICK_VOTES", { accepts: (data) => data.kickVotes.length > 0 });
  host.emit("suspend-room", { code: room.code });
  const vote = (await opened).kickVotes[0];
  assert.equal(vote.requiredYes, 2);
  const payload = { code: room.code, playerId: host.session.playerId, voteId: vote.id, choice: "yes" };
  assert.equal((await ack(first, "VOTE_ROOM_KICK", payload)).success, true);
  const restored = next(first, "room-restored"), resumed = next(first, "ROOM_RESUMED");
  assert.equal((await ack(second, "VOTE_ROOM_KICK", payload)).success, true);
  await resumed;
  const snapshot = await restored;
  assert.equal(snapshot.pausedAt, null); assert.equal(snapshot.players.length, 2);
  assert.equal(snapshot.gameState.gameId, state.gameId);
  assert.equal(snapshot.gameState.currentPlayerId, first.session.playerId);
  assert.ok(snapshot.availableCharacters.includes(state.players[state.currentTurnIndex].characterId));
  const remaining = snapshot.gameState.turnEndsAt - snapshot.gameState.serverNow;
  assert.ok(remaining <= 15000 && remaining >= 14900, `Expected a fresh 15s turn, received ${remaining}ms`);
  assert.equal((await ack(host, "resume-room", host.session)).success, false);
});

test("timeout elimination broadcasts a winner and rematches require fresh readiness", { timeout: 90000 }, async (t) => {
  const { room, sockets, host, state: initial } = await makeRoom(t);
  let state = initial;
  for (let turn = 0; turn < 5; turn++) {
    const changed = next(host, turn === 4 ? "game_over" : "turn_start", { timeout: 18000 });
    state = await changed;
  }
  assert.equal(state.status, "ENDED"); assert.equal(state.winnerId, sockets.find((socket) => socket.session.playerId !== initial.currentPlayerId).session.playerId);
  assert.equal(state.players.find((player) => player.id === initial.currentPlayerId).lives, 0);
  const lobby = next(host, "rematch-lobby"); host.emit("rematch", { code: room.code });
  const waiting = await lobby;
  assert.equal(waiting.gameMode, "finish-word"); assert.equal(waiting.availableCharacters.length, 6);
  assert.ok(waiting.players.every((player) => !player.ready));
  assert.equal((await ack(host, "submit_word", { code: room.code, turnId: initial.turnId, word: "apple" })).success, false);
  const started = next(host, "turn_start");
  assert.equal((await ack(host, "start_game", { code: room.code })).success, false);
  for (const socket of sockets) assert.equal((await ack(socket, "toggle-ready", { code: room.code })).ready, true);
  assert.equal((await ack(host, "start_game", { roomId: room.code })).success, true);
  const rematch = await started;
  assert.notEqual(rematch.gameId, initial.gameId); assert.deepEqual(rematch.usedWords, []);
  assert.ok(rematch.players.every((player) => player.lives === 3 && player.isAlive));
  assert.deepEqual(rematch.players.map((player) => player.characterId), ["knight", "wizard"]);
});

test("explicit departures preserve the active match and the last remaining player wins", async (t) => {
  const { room, sockets, state } = await makeRoom(t, { count: 3 });
  const [host, nextPlayer, survivor] = [...sockets.slice(state.currentTurnIndex), ...sockets.slice(0, state.currentTurnIndex)];
  const word = dictionary.find((candidate) => candidate.startsWith(state.requiredPrefix));
  const nextTurn = next(nextPlayer, "turn_start", { accepts: (snapshot) => snapshot.turnId !== state.turnId && snapshot.currentPlayerId === nextPlayer.session.playerId });
  await ack(host, "submit_word", { code: room.code, turnId: state.turnId, word });
  const playing = await nextTurn;
  const changed = next(nextPlayer, "game_state");
  assert.equal((await ack(host, "leave-room", { code: room.code })).success, true);
  const remaining = await changed;
  assert.equal(remaining.gameId, state.gameId); assert.equal(remaining.players.length, 2);
  assert.equal(remaining.currentPlayerId, nextPlayer.session.playerId);
  assert.equal(remaining.turnId, playing.turnId); assert.equal(remaining.turnEndsAt, playing.turnEndsAt);
  assert.ok(remaining.usedWords.includes(word));
  const ended = next(survivor, "game_over");
  assert.equal((await ack(nextPlayer, "leave-room", { code: room.code })).success, true);
  const result = await ended;
  assert.equal(result.status, "ENDED"); assert.equal(result.winnerId, survivor.session.playerId);
  assert.equal(result.players.length, 1); assert.equal(result.gameId, state.gameId);
});
