const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { FinishWordRounds, FINISH_WORD_CHARACTERS } = require("../src/socket/FinishWordSocket");
const { FinishWordGame, MAX_WORD_LENGTH } = require("../src/services/FinishWordGame");

function setup(t, { count = 3, start = true, dictionaryCount = 8 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const players = Array.from({ length: count }, (_, index) => ({
    id: `player-${index}`, socketId: `socket-${index}`, username: `Player ${index}`,
    connected: true, ready: start, characterId: start ? FINISH_WORD_CHARACTERS[index] : null, wins: 0,
  }));
  const room = { code: "FINISH", creatorId: players[0].id, gameMode: "finish-word", maxPlayers: 8, state: "waiting", players, pausedAt: null };
  const rooms = { FINISH: room }, events = [], queries = [];
  const words = new Set(["apple", "elephant", "turtle", "eagle", "echo", "orange", "at", "tea"]);
  const dictionary = { count: dictionaryCount, isValidWord: (word) => { queries.push(word); return words.has(word); } };
  const manager = new FinishWordRounds({ rooms, dictionary,
    io: { to: (target) => ({ emit: (event, data) => events.push({ target, event, data: structuredClone(data) }) }) },
    publicPlayers: (target) => target.players.map((player) => ({ id: player.id, username: player.username, connected: player.connected, ready: player.ready, characterId: player.characterId, wins: player.wins })),
    game: new FinishWordGame({ isValidWord: dictionary.isValidWord, randomLetter: () => "a", randomPlayerIndex: () => 0 }),
  });
  t.after(() => manager.clear(room.code));
  const makeSocket = (id, playerId = id) => {
    const socket = new EventEmitter(); socket.id = id; socket.data = { playerId, lobbyCode: room.code };
    manager.register(socket); return socket;
  };
  const sockets = players.map((player) => makeSocket(player.socketId, player.id));
  const outsider = makeSocket("outsider");
  const act = (client, event, changes = {}) => {
    let response;
    (typeof client === "number" ? sockets[client] : client).emit(event, { code: room.code, turnId: room.finishWordGame?.turnId, ...changes }, (reply) => { response = reply; });
    return response;
  };
  if (start) manager.start(room);
  return { room, rooms, manager, events, queries, sockets, outsider, makeSocket, act };
}

test("eight characters lock exclusively in real time and switching releases the previous choice", (t) => {
  const { room, act, events } = setup(t, { start: false });
  assert.equal(new Set(FINISH_WORD_CHARACTERS).size, 8);
  const selected = act(0, "select_character", { characterId: "knight" });
  assert.equal(selected.success, true); assert.equal(room.players[0].ready, false);
  room.players[0].ready = true;
  act(0, "select_character", { characterId: "knight" });
  assert.equal(room.players[0].ready, true, "reselecting the same character keeps readiness");
  assert.equal(selected.availableCharacters.includes("knight"), false);
  assert.equal(act(1, "select_character", { characterId: "knight" }).success, false);
  assert.equal(room.players[1].characterId, null);
  const switched = act(0, "select_character", { characterId: "wizard" });
  assert.equal(switched.success, true);
  assert.equal(room.players[0].ready, false, "changing characters requires readying up again");
  assert.ok(switched.availableCharacters.includes("knight"));
  assert.equal(switched.availableCharacters.includes("wizard"), false);
  assert.equal(act(1, "select_character", { characterId: "knight", code: undefined, roomId: room.code }).success, true);
  assert.equal(room.players[0].characterId, "wizard"); assert.equal(room.players[1].characterId, "knight");
  assert.equal(events.filter((entry) => entry.event === "character_selected").length, 4);
  assert.ok(events.every((entry) => entry.target === room.code));
});

test("character selection rejects outsiders, replaced sockets, disconnected players, paused rooms and running matches", (t) => {
  const { room, act, outsider, makeSocket, manager } = setup(t, { start: false });
  assert.equal(act(outsider, "select_character", { characterId: "knight" }).success, false);
  const oldSocket = makeSocket("old-transport", room.players[0].id);
  assert.equal(act(oldSocket, "select_character", { characterId: "knight" }).success, false);
  assert.equal(act(0, "select_character", { characterId: "unknown" }).success, false);
  room.players[0].connected = false;
  assert.equal(act(0, "select_character", { characterId: "knight" }).success, false);
  room.players[0].connected = true; room.pausedAt = Date.now();
  assert.match(act(0, "select_character", { characterId: "knight" }).message, /paused/);
  room.pausedAt = null;
  room.players.forEach((player, index) => act(index, "select_character", { characterId: FINISH_WORD_CHARACTERS[index] }));
  manager.start(room);
  assert.match(act(0, "select_character", { characterId: "robot" }).message, /lobby/);
});

test("starting a game broadcasts its active turn, character/life roster and one server timer", (t) => {
  const { room, manager, events } = setup(t);
  assert.equal(room.state, "playing"); assert.equal(manager.timers.size, 1);
  assert.ok(room.players.every((player) => !player.ready));
  const turns = events.filter((entry) => entry.event === "turn_start");
  assert.equal(turns.length, 1);
  const state = turns[0].data;
  assert.equal(state.currentPlayerId, room.players[0].id); assert.equal(state.requiredPrefix, "a");
  assert.equal(state.turnEndsAt - state.serverNow, 15000);
  assert.equal(state.players.length, 3); assert.ok(state.players.every((player) => player.lives === 3 && player.isAlive && player.characterId));
  assert.equal(state.roomId, room.code);
  assert.deepEqual(manager.snapshot(room).gameState, state);
  manager.schedule(room); manager.schedule(room);
  assert.equal(manager.timers.size, 1);
  t.mock.timers.tick(15000);
  assert.equal(events.filter((entry) => entry.event === "word_rejected").length, 1, "rescheduling must cancel duplicate callbacks");
});

test("an empty dictionary cannot start a match or schedule a timer", (t) => {
  const { room, manager, events } = setup(t, { start: false, dictionaryCount: 0 });
  assert.throws(() => manager.start(room), /dictionary is empty/);
  assert.equal(room.state, "waiting"); assert.equal(manager.timers.size, 0); assert.equal(events.length, 0);
});

test("typing broadcasts bounded plain text only for the active live turn and throttles rapid packets", (t) => {
  const { room, act, outsider, events, queries } = setup(t);
  assert.equal(act(0, "player_typing", { text: "AppLe" }).success, true);
  assert.equal(room.finishWordGame.typingText, "AppLe");
  let typed = events.filter((entry) => entry.event === "player_typing");
  assert.equal(typed.length, 1); assert.equal(typed[0].data.text, "AppLe");
  assert.deepEqual(act(0, "player_typing", { text: "Apple" }), { success: true, throttled: true });
  assert.equal(room.finishWordGame.typingText, "Apple", "the latest draft remains available to recovery snapshots");
  assert.equal(events.filter((entry) => entry.event === "player_typing").length, 1);
  t.mock.timers.tick(26);
  assert.equal(act(1, "player_typing", { text: "hijack" }).success, false);
  assert.equal(act(outsider, "player_typing", { text: "hijack" }).success, false);
  assert.equal(act(0, "player_typing", { text: "stale", turnId: "old-turn" }).success, false);
  assert.equal(act(0, "player_typing", { text: "a".repeat(1000) + "<script>" }).success, true);
  t.mock.timers.tick(25);
  typed = events.filter((entry) => entry.event === "player_typing");
  assert.equal(typed.at(-1).data.text.length, MAX_WORD_LENGTH);
  assert.equal(queries.length, 0, "typing must never query the dictionary");
  room.pausedAt = Date.now(); t.mock.timers.tick(26);
  assert.equal(act(0, "player_typing", { text: "paused" }).success, false);
});

test("batched typing packets keep the latest text and broadcast it once at the rate-limit boundary", (t) => {
  const { room, act, events } = setup(t);
  act(0, "player_typing", { text: "A" });
  assert.deepEqual(act(0, "player_typing", { text: "Ap" }), { success: true, throttled: true });
  t.mock.timers.tick(5);
  assert.deepEqual(act(0, "player_typing", { text: "App" }), { success: true, throttled: true });
  assert.equal(room.finishWordGame.typingText, "App");
  t.mock.timers.tick(19);
  assert.deepEqual(events.filter((entry) => entry.event === "player_typing").map((entry) => entry.data.text), ["A"]);
  t.mock.timers.tick(1);
  assert.deepEqual(events.filter((entry) => entry.event === "player_typing").map((entry) => entry.data.text), ["A", "App"]);
  t.mock.timers.tick(1000);
  assert.equal(events.filter((entry) => entry.event === "player_typing").length, 2);
});

test("a new turn cancels trailing typing from the previous player", (t) => {
  const { room, act, events } = setup(t);
  const oldTurn = room.finishWordGame.turnId;
  act(0, "player_typing", { text: "a" });
  assert.equal(act(0, "player_typing", { text: "app" }).throttled, true);
  assert.equal(act(0, "submit_word", { word: "apple" }).accepted, true);
  assert.notEqual(room.finishWordGame.turnId, oldTurn);
  assert.equal(room.finishWordGame.typingText, "");
  t.mock.timers.tick(25);
  assert.deepEqual(events.filter((entry) => entry.event === "player_typing").map((entry) => entry.data.text), ["a"]);
  assert.equal(act(1, "player_typing", { text: "ele" }).success, true);
  t.mock.timers.tick(25);
  const typed = events.filter((entry) => entry.event === "player_typing");
  assert.deepEqual(typed.map((entry) => entry.data.text), ["a", "ele"]);
  assert.notEqual(typed[1].data.turnId, oldTurn);
});

test("pausing cancels a trailing typing broadcast while preserving the latest recoverable draft", (t) => {
  const { room, manager, act, events } = setup(t);
  act(0, "player_typing", { text: "a" });
  act(0, "player_typing", { text: "app" });
  room.pausedAt = Date.now(); manager.clear(room.code);
  t.mock.timers.tick(50);
  assert.deepEqual(events.filter((entry) => entry.event === "player_typing").map((entry) => entry.data.text), ["a"]);
  assert.equal(manager.snapshot(room).gameState.typingText, "app");
});

test("accepted words advance while rejected attempts clear live typing and keep the original timer and turn", (t) => {
  const { room, manager, act, events, queries } = setup(t);
  const firstTurn = room.finishWordGame.turnId;
  const accepted = act(0, "submit_word", { word: " APPLE " });
  assert.equal(accepted.success, true); assert.equal(accepted.accepted, true);
  assert.deepEqual(queries, ["apple"]);
  assert.equal(room.finishWordGame.requiredPrefix, "e"); assert.equal(manager.timers.size, 1);
  assert.equal(events.filter((entry) => entry.event === "word_accepted").length, 1);
  assert.equal(events.filter((entry) => entry.event === "turn_start").at(-1).data.currentPlayerId, room.players[1].id);
  assert.equal(act(0, "submit_word", { word: "apple", turnId: firstTurn }).success, false);
  const turnId = room.finishWordGame.turnId, deadline = room.finishWordGame.turnEndsAt;
  const timer = manager.timers.get(room.code);
  act(1, "player_typing", { text: "a" });
  act(1, "player_typing", { text: "apple" });
  t.mock.timers.tick(4000);
  const rejected = act(1, "submit_word", { word: "apple" });
  assert.equal(rejected.success, true, "a valid command may still contain a rejected word");
  assert.equal(rejected.accepted, false); assert.equal(rejected.retryable, true);
  assert.equal(room.finishWordGame.players[1].lives, 3);
  assert.equal(room.finishWordGame.currentTurnIndex, 1); assert.equal(manager.timers.size, 1);
  assert.equal(manager.timers.get(room.code), timer);
  assert.equal(room.finishWordGame.turnId, turnId); assert.equal(room.finishWordGame.turnEndsAt, deadline);
  assert.equal(room.finishWordGame.typingText, "");
  assert.equal(events.filter((entry) => entry.event === "player_typing").at(-1).data.text, "");
  assert.equal(events.filter((entry) => entry.event === "word_rejected").length, 1);
  assert.equal(events.filter((entry) => entry.event === "turn_start").length, 2);
  act(1, "player_typing", { text: "elephant" });
  assert.equal(act(1, "submit_word", { word: "elephant", turnId }).accepted, true);
  assert.equal(room.finishWordGame.currentTurnIndex, 2);
  assert.equal(room.finishWordGame.players[1].lives, 3);
});

test("everyone timing out broadcasts new letters without resetting lives or successful-word progress", (t) => {
  const { room, events } = setup(t);
  const originalPrefix = room.finishWordGame.requiredPrefix;
  for (let turn = 0; turn < 3; turn++) t.mock.timers.tick(15000);
  const state = events.filter((entry) => entry.event === "turn_start").at(-1).data;
  assert.notEqual(state.requiredPrefix, originalPrefix);
  assert.equal(state.turnEndsAt - state.serverNow, 15000);
  assert.ok(state.players.every((player) => player.lives === 2));
  assert.equal(events.filter((entry) => entry.event === "word_rejected").at(-1).data.prefixChanged, true);
});

test("rejected attempts cannot delay or duplicate the existing timeout", (t) => {
  const { room, manager, act, events } = setup(t);
  const turnId = room.finishWordGame.turnId;
  t.mock.timers.tick(14999);
  assert.equal(act(0, "submit_word", { word: "azzzz" }).retryable, true);
  assert.equal(act(0, "submit_word", { word: "azzzz" }).retryable, true);
  assert.equal(room.finishWordGame.players[0].lives, 3);
  t.mock.timers.tick(1);
  assert.equal(room.finishWordGame.players[0].lives, 2);
  assert.equal(room.finishWordGame.currentTurnIndex, 1);
  assert.equal(events.filter((entry) => entry.event === "word_rejected" && entry.data.reason === "timeout").length, 1);
  assert.equal(act(0, "submit_word", { word: "apple", turnId }).success, false);
  assert.equal(manager.timers.size, 1);
});

test("outsider, stale and non-active submissions cannot consume lives or query SQLite", (t) => {
  const { room, act, outsider, events, queries } = setup(t);
  for (const [client, payload] of [[outsider, {}], [1, {}], [0, { turnId: "stale" }], [0, { code: "WRONG" }]]) assert.equal(act(client, "submit_word", { word: "apple", ...payload }).success, false);
  assert.ok(room.finishWordGame.players.every((player) => player.lives === 3));
  assert.equal(queries.length, 0);
  assert.equal(events.filter((entry) => entry.event === "word_rejected").length, 0);
});

test("the server deadline advances once and stale submissions cannot repeat its life penalty", (t) => {
  const { room, manager, act, events } = setup(t);
  const firstTurn = room.finishWordGame.turnId;
  t.mock.timers.tick(14999);
  assert.equal(room.finishWordGame.players[0].lives, 3);
  t.mock.timers.tick(1);
  assert.equal(room.finishWordGame.players[0].lives, 2);
  assert.equal(room.finishWordGame.currentTurnIndex, 1);
  assert.equal(events.filter((entry) => entry.event === "word_rejected").at(-1).data.reason, "timeout");
  assert.equal(act(0, "submit_word", { word: "apple", turnId: firstTurn }).success, false);
  assert.equal(room.finishWordGame.players[0].lives, 2); assert.equal(manager.timers.size, 1);
});

test("pausing and resuming preserves typing and exactly the remaining turn time", (t) => {
  const { room, manager, act, events } = setup(t);
  act(0, "player_typing", { text: "app" });
  t.mock.timers.tick(3000);
  const originalTurn = room.finishWordGame.turnId;
  room.pausedAt = Date.now(); manager.clear(room.code);
  t.mock.timers.tick(45000);
  assert.equal(events.filter((entry) => entry.event === "word_rejected").length, 0);
  const pauseDuration = Date.now() - room.pausedAt;
  room.pausedAt = null; manager.resume(room, pauseDuration);
  assert.equal(room.finishWordGame.typingText, "app"); assert.equal(room.finishWordGame.turnId, originalTurn);
  assert.equal(room.finishWordGame.turnEndsAt - Date.now(), 12000);
  t.mock.timers.tick(11999); assert.equal(room.finishWordGame.players[0].lives, 3);
  t.mock.timers.tick(1); assert.equal(room.finishWordGame.players[0].lives, 2);
});

test("elimination ends a two-player game, awards one win and cancels the countdown", (t) => {
  const { room, manager, events } = setup(t, { count: 2 });
  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(15000);
  }
  assert.equal(room.state, "ended"); assert.equal(manager.timers.size, 0);
  const ended = events.filter((entry) => entry.event === "game_over");
  assert.equal(ended.length, 1); assert.equal(ended[0].data.winnerId, room.players[1].id);
  assert.deepEqual(events.filter((entry) => entry.event === "player_eliminated").at(-1).data.playerIds, [room.players[0].id]);
  assert.equal(room.players[1].wins, 1);
  manager.publish(room); assert.equal(room.players[1].wins, 1, "recovery publications must not award the winner again");
  assert.equal(manager.snapshot(room).result.status, "ENDED");
  const rejectedBefore = events.filter((entry) => entry.event === "word_rejected").length;
  t.mock.timers.tick(60000);
  assert.equal(events.filter((entry) => entry.event === "word_rejected").length, rejectedBefore);
});

test("removing the active player continues with the next seat and rejects their old socket", (t) => {
  const { room, manager, act, events } = setup(t);
  const removedId = room.players[0].id;
  room.players.splice(0, 1);
  manager.removePlayer(room, removedId);
  const state = manager.state(room);
  assert.equal(state.players.length, 2); assert.equal(state.currentPlayerId, room.players[0].id);
  assert.equal(state.turnEndsAt - state.serverNow, 15000); assert.equal(manager.timers.size, 1);
  assert.equal(events.filter((entry) => entry.event === "player_eliminated").at(-1).data.playerIds[0], removedId);
  assert.equal(act(0, "submit_word", { word: "apple" }).success, false);
});

test("removing an active player during a pause does not add the old pause to the new turn", (t) => {
  const { room, manager } = setup(t);
  t.mock.timers.tick(2000);
  room.pausedAt = Date.now(); manager.clear(room.code);
  t.mock.timers.tick(45000);
  const removedId = room.players[0].id;
  room.players.splice(0, 1);
  manager.removePlayer(room, removedId);
  const duration = Date.now() - room.pausedAt;
  room.pausedAt = null; manager.resume(room, duration);
  assert.equal(manager.state(room).turnEndsAt - Date.now(), 15000);
});

test("clearing a deleted or cancelled room prevents a stale timer from broadcasting", (t) => {
  const { room, rooms, manager, events } = setup(t);
  const before = events.length;
  manager.clear(room.code); delete rooms[room.code];
  t.mock.timers.tick(60000);
  assert.equal(events.length, before); assert.equal(manager.timers.size, 0);
});
