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
  socket.on("room-session", (session) => { socket.session = session; });
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
    assert.equal((await updated).changedPlayerId, socket.session?.playerId || socket.id);
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

test("Color Card previous-match averages survive rematches, then reset after a disconnect or quit", { timeout: 25000 }, async (t) => {
  const host = await connect(t);
  const sessionPromise = next(host, "room-session");
  const created = next(host, "room-created");
  host.emit("CREATE_ROOM", { username: "Host", gameMode: "color-card", colorCardCount: 1 });
  const state = await created;
  const session = await sessionPromise;
  assert.equal(state.players[0].previousMatchAverageAccuracy, 0);
  assert.equal(state.players[0].previousMatchCardCount, 0);
  const guest = await connect(t);
  const joined = next(guest, "room-joined");
  guest.emit("join-room", { code: state.code, username: "Guest" }); await joined;
  const room = { ...state, host, sockets: [host, guest] };
  const round = await startColor(room);
  const poll = next(host, "COLOR_SKIP_VOTE");
  for (const socket of room.sockets) await ack(socket, "SUBMIT_COLOR", { code: room.code, roundId: round.roundId, hex: round.targetColor });
  const vote = (await poll).vote;
  const review = next(host, "ROUND_RESULTS");
  const ranking = next(host, "COLOR_RANKINGS", 7000);
  for (const socket of room.sockets) await ack(socket, "VOTE_COLOR_SKIP", { code: room.code, roundId: round.roundId, voteId: vote.id, choice: "yes" });
  assert.ok((await review).players.every((player) => player.previousMatchAverageAccuracy === undefined));
  await ranking;
  const lobby = next(host, "rematch-lobby");
  host.emit("rematch", { code: room.code });
  for (const player of (await lobby).players) {
    assert.equal(player.previousMatchAverageAccuracy, 100);
    assert.equal(player.previousMatchCardCount, 1);
  }
  const restored = next(host, "room-restored");
  assert.equal((await ack(host, "resume-room", session)).success, true);
  assert.ok((await restored).players.every((player) => player.previousMatchAverageAccuracy === 100));
  const backgrounded = next(guest, "ROOM_PAUSED");
  host.emit("suspend-room", { code: room.code });
  assert.ok((await backgrounded).players.every((player) => player.previousMatchAverageAccuracy === 100));
  const foregrounded = next(host, "room-restored");
  await ack(host, "resume-room", session);
  assert.ok((await foregrounded).players.every((player) => player.previousMatchAverageAccuracy === 100));
  const paused = next(guest, "ROOM_PAUSED");
  host.io.engine.close();
  assert.ok((await paused).players.every((player) => player.previousMatchAverageAccuracy === 0 && player.previousMatchCardCount === 0));
  const recovered = await connect(t);
  const recoveredState = next(recovered, "room-restored");
  assert.equal((await ack(recovered, "resume-room", session)).success, true);
  assert.ok((await recoveredState).players.every((player) => player.previousMatchAverageAccuracy === 0));

  const newRoom = { ...room, host: recovered, sockets: [recovered, guest] };
  const newRound = await startColor(newRoom);
  const newPoll = next(recovered, "COLOR_SKIP_VOTE");
  for (const socket of newRoom.sockets) await ack(socket, "SUBMIT_COLOR", { code: room.code, roundId: newRound.roundId, hex: newRound.targetColor });
  const newVote = (await newPoll).vote;
  const newRanking = next(recovered, "COLOR_RANKINGS", 7000);
  for (const socket of newRoom.sockets) await ack(socket, "VOTE_COLOR_SKIP", { code: room.code, roundId: newRound.roundId, voteId: newVote.id, choice: "yes" });
  await newRanking;
  const newLobby = next(recovered, "rematch-lobby");
  recovered.emit("rematch", { code: room.code });
  assert.ok((await newLobby).players.every((player) => player.previousMatchAverageAccuracy === 100));
  const departure = next(recovered, "rematch-lobby");
  assert.equal((await ack(guest, "leave-room", { code: room.code })).success, true);
  const remaining = (await departure).players;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].previousMatchAverageAccuracy, 0);
  assert.equal(remaining[0].previousMatchCardCount, 0);
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

for (const mode of ["word-duel", "color-card"]) {
  for (const phase of ["waiting", "playing"]) {
    test(`${mode}: quitting ${phase} notifies everyone, transfers the host, and releases membership`, async (t) => {
      const room = await makeRoom(t, 3, mode);
      if (phase === "playing") {
        await ready(room);
        const started = next(room.host, mode === "word-duel" ? "category-selected" : "START_GAME");
        assert.equal((await ack(room.host, "START_GAME", { code: room.code })).success, true);
        await started;
        if (mode === "word-duel") {
          const game = next(room.host, "game-start");
          room.sockets.forEach((socket) => socket.emit("slot-machine-done", { code: room.code }));
          await game;
        }
      }
      const guests = room.sockets.slice(1);
      const notices = guests.map((socket) => next(socket, "player-left"));
      const chats = guests.map((socket) => next(socket, "chat-message"));
      const lobbies = guests.map((socket) => next(socket, "rematch-lobby"));
      const hostId = room.host.id;
      assert.equal((await ack(room.host, "leave-room", { code: room.code })).success, true);
      assert.equal(room.host.connected, true);
      for (const notice of await Promise.all(notices)) {
        assert.equal(notice.playerId, hostId);
        assert.equal(notice.disconnected, false);
        assert.match(notice.message, /Host quit the room/);
      }
      for (const chat of await Promise.all(chats)) {
        assert.equal(chat.system, true);
        assert.match(chat.text, /Host quit the room/);
      }
      for (const lobby of await Promise.all(lobbies)) {
        assert.equal(lobby.creatorId, guests[0].id);
        assert.equal(lobby.players.length, 2);
        assert.ok(lobby.players.every((player) => !player.ready));
        assert.equal(lobby.departure, true);
        if (phase === "playing") assert.match(lobby.message, /cancelled/);
      }
      assert.equal((await ack(room.host, "leave-room", { code: room.code })).success, false);
      const leaked = [];
      room.host.on("chat-message", (message) => leaked.push(message));
      const newRoom = await ack(room.host, "CREATE_ROOM", { username: "New host", gameMode: mode });
      assert.equal(newRoom.success, true);
      const chat = next(guests[0], "chat-message");
      guests[1].emit("chat-message", { code: room.code, text: "Still in the old room" });
      await chat;
      assert.deepEqual(leaked, []);
      const newcomer = await connect(t);
      const history = next(newcomer, "chat-history");
      newcomer.emit("JOIN_ROOM", { code: room.code, username: "New guest" });
      assert.equal((await history).messages.filter((message) => /Host quit the room/.test(message.text)).length, 1);
    });
  }
}

test("outsiders cannot quit another room, and quitting a bot room removes its last human", async (t) => {
  const room = await makeRoom(t);
  const outsider = await connect(t);
  assert.equal((await ack(outsider, "leave-room", { code: room.code })).success, false);
  const created = next(outsider, "room-created");
  outsider.emit("create-bot-room", { username: "Solo" });
  const botRoom = await created;
  assert.equal((await ack(outsider, "leave-room", { code: botRoom.code })).success, true);
  const rejected = next(outsider, "join-error");
  outsider.emit("join-room", { code: botRoom.code, username: "Again" });
  assert.equal((await rejected).message, "Room not found.");
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
