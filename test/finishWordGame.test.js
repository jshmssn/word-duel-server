const test = require("node:test");
const assert = require("node:assert/strict");
const { FinishWordGame, MAX_WORD_LENGTH } = require("../src/services/FinishWordGame");

const players = [
  { id: "one", username: "One", characterId: "knight" },
  { id: "two", username: "Two", characterId: "wizard" },
  { id: "three", username: "Three", characterId: "ninja" },
];

function fixture({ count = 3, words = ["apple", "elephant", "turtle", "eagle", "echo", "orange", "at", "tea", "tape", "pearl", "ring"] } = {}) {
  let now = 1000;
  const queries = [];
  const dictionary = new Set(words);
  const service = new FinishWordGame({ isValidWord: (word) => { queries.push(word); return dictionary.has(word); }, now: () => now, randomLetter: () => "A" });
  const game = service.start(players.slice(0, count));
  const submit = (word, changes = {}) => service.submit(game, { playerId: game.players[game.currentTurnIndex]?.id, word, turnId: game.turnId, ...changes });
  return { service, game, submit, queries, setNow: (value) => { now = value; }, advance: (value) => { now += value; } };
}

test("a match starts with three lives, a server deadline, unique turn ID and safe public snapshots", () => {
  const { service, game } = fixture();
  const state = service.publicState(game);
  assert.equal(state.gameMode, "finish-word");
  assert.equal(state.status, "PLAYING"); assert.equal(state.currentPlayerId, "one");
  assert.equal(state.turnDuration, 10); assert.equal(state.turnEndsAt, 11000);
  assert.equal(state.requiredPrefix, "a"); assert.equal(state.hardMode, false);
  assert.ok(state.turnId); assert.ok(state.gameId);
  assert.ok(state.players.every((player) => player.lives === 3 && player.isAlive));
  assert.deepEqual(state.usedWords, []);
  assert.equal(JSON.stringify(state).includes("usedWordsSet"), false);
  state.players[0].lives = 0;
  assert.equal(game.players[0].lives, 3);
  assert.throws(() => new FinishWordGame(), /isValidWord/);
  assert.throws(() => service.start([players[0]]), /2 to 8/);
  assert.throws(() => service.start([players[0], players[0]]), /unique/);
  assert.throws(() => service.start(players, { turnDuration: 0 }), /duration/);
});

test("case-insensitive exact dictionary matches advance the last-letter chain without changing lives", () => {
  const { service, game, submit, queries } = fixture();
  const firstTurn = game.turnId;
  assert.equal(submit(" APPLE ").accepted, true);
  assert.equal(game.lastWord, "apple"); assert.equal(game.requiredPrefix, "e");
  assert.equal(service.publicState(game).currentPlayerId, "two");
  assert.notEqual(game.turnId, firstTurn);
  assert.equal(submit("Elephant").accepted, true);
  assert.equal(game.requiredPrefix, "t");
  assert.equal(submit("TURTLE").accepted, true);
  assert.deepEqual([...game.usedWordsSet], ["apple", "elephant", "turtle"]);
  assert.deepEqual(queries, ["apple", "elephant", "turtle"]);
  assert.ok(game.players.every((player) => player.lives === 3));
});

for (const [word, reason] of [["a", "too_short"], ["a!", "invalid_format"], ["elephant", "wrong_prefix"], ["abcdefgh", "not_in_dictionary"], [null, "too_short"], ["a".repeat(MAX_WORD_LENGTH + 1), "invalid_format"]]) {
  test(`invalid submission (${reason}) costs one life and passes exactly one turn`, () => {
    const { game, submit, queries } = fixture();
    const outcome = submit(word);
    assert.equal(outcome.accepted, false); assert.equal(outcome.reason, reason);
    assert.equal(outcome.playerId, "one"); assert.deepEqual(outcome.eliminatedPlayerIds, []);
    assert.equal(game.players[0].lives, 2); assert.equal(game.currentTurnIndex, 1);
    assert.equal(game.requiredPrefix, "a"); assert.equal(game.lastWord, null);
    assert.equal(game.usedWordsSet.size, 0);
    if (reason !== "not_in_dictionary") assert.equal(queries.length, 0);
  });
}

test("oversized invalid words lose one life without retaining or broadcasting the oversized payload", () => {
  const { service, game, submit, queries } = fixture();
  const outcome = submit("A".repeat(200000));
  assert.equal(outcome.accepted, false); assert.equal(outcome.reason, "invalid_format");
  assert.equal(game.players[0].lives, 2); assert.equal(game.currentTurnIndex, 1);
  assert.equal(outcome.word.length, MAX_WORD_LENGTH);
  assert.equal(game.history[0].word.length, MAX_WORD_LENGTH);
  assert.equal(service.publicState(game).history[0].word.length, MAX_WORD_LENGTH);
  assert.equal(queries.length, 0); assert.equal(game.usedWordsSet.size, 0);
  assert.equal(game.lastWord, null);
});

test("a used word is rejected case-insensitively for the rest of the match", () => {
  const { game, submit } = fixture();
  submit("at"); submit("tea");
  const outcome = submit("AT");
  assert.equal(outcome.reason, "already_used");
  assert.equal(game.players[2].lives, 2);
  assert.equal(game.lastWord, "tea"); assert.equal(game.usedWordsSet.size, 2);
});

test("unknown players, stale actions and out-of-turn players cannot damage a player or query the dictionary", () => {
  const { service, game, submit, queries } = fixture();
  const before = JSON.stringify(service.publicState(game));
  for (const changes of [{ playerId: "outsider" }, { playerId: "two" }, { turnId: "stale" }, { turnId: undefined }]) assert.throws(() => submit("apple", changes));
  assert.equal(JSON.stringify(service.publicState(game)), before);
  assert.equal(queries.length, 0);
  const turnId = game.turnId;
  submit("apple");
  assert.throws(() => submit("apple", { playerId: "one", turnId }), /turn/);
  assert.equal(game.players[0].lives, 3);
});

test("a deadline timeout costs one life exactly once and a late word never reaches SQLite", () => {
  const { service, game, submit, queries, setNow } = fixture();
  const originalTurn = game.turnId;
  assert.equal(service.expire(game, originalTurn), null);
  setNow(game.turnEndsAt);
  const outcome = submit("apple");
  assert.equal(outcome.reason, "timeout");
  assert.equal(game.players[0].lives, 2); assert.equal(game.currentTurnIndex, 1);
  assert.equal(queries.length, 0);
  assert.equal(service.expire(game, originalTurn), null);
  assert.equal(game.players[1].lives, 3);
  assert.throws(() => submit("apple", { playerId: "one", turnId: originalTurn }));
});

test("eliminated players are skipped and the last survivor ends the match", () => {
  const { service, game, submit } = fixture({ count: 2 });
  for (let round = 0; round < 2; round++) { submit("bad"); submit("bad"); }
  assert.ok(game.players.every((player) => player.lives === 1));
  const outcome = submit("bad");
  assert.deepEqual(outcome.eliminatedPlayerIds, ["one"]); assert.equal(outcome.gameOver, true);
  assert.equal(game.status, "ENDED"); assert.equal(game.winnerId, "two"); assert.equal(game.winnerName, "Two");
  assert.equal(game.turnId, null); assert.equal(game.turnEndsAt, null);
  assert.equal(service.publicState(game).currentPlayerId, null);
  assert.throws(() => submit("apple"), /ended/);
  assert.equal(service.expire(game, "old"), null);
});

test("surviving turns skip eliminated seats while retaining them in the scene", () => {
  const { service, game, submit } = fixture();
  game.players[1].lives = 1;
  submit("bad");
  assert.deepEqual(submit("bad").eliminatedPlayerIds, ["two"]);
  assert.equal(service.publicState(game).currentPlayerId, "three");
  submit("bad");
  assert.equal(service.publicState(game).currentPlayerId, "one");
  assert.equal(game.players.length, 3);
  assert.throws(() => submit("apple", { playerId: "two" }), /eliminated/);
});

test("hard mode begins at the configured successful-turn threshold and strictly keeps two-letter suffixes", () => {
  const { service, game, submit } = fixture();
  game.hardModeAfter = 2;
  submit("apple");
  assert.equal(game.requiredPrefix, "e"); assert.equal(service.publicState(game).hardMode, false);
  submit("elephant");
  assert.equal(game.requiredPrefix, "nt"); assert.equal(service.publicState(game).hardMode, true);
  const rejected = submit("turtle");
  assert.equal(rejected.reason, "wrong_prefix");
  assert.equal(game.requiredPrefix, "nt");
  // An impossible suffix is still the required suffix; no silent easy-mode
  // fallback may change the chain or award a client an invalid word.
  assert.equal(submit("ntword").reason, "not_in_dictionary");
  assert.equal(game.requiredPrefix, "nt");
});

test("hard mode accepts a real two-letter continuation and carries its new suffix forward", () => {
  const { game, submit } = fixture();
  game.hardModeAfter = 1;
  submit("at");
  assert.equal(game.requiredPrefix, "at");
  assert.equal(submit("at").reason, "already_used");
  game.requiredPrefix = "ta";
  assert.equal(submit("tape").accepted, true);
  assert.equal(game.requiredPrefix, "pe");
  assert.equal(submit("pearl").accepted, true);
  assert.equal(game.requiredPrefix, "rl");
});

test("live typing is bounded, sanitized, turn-scoped and cleared when a turn changes", () => {
  const { service, game, submit, setNow } = fixture();
  const action = (text, changes = {}) => service.updateTyping(game, { playerId: "one", text, turnId: game.turnId, ...changes });
  assert.equal(action("AppLe"), "AppLe");
  assert.equal(service.publicState(game).typingText, "AppLe");
  assert.equal(action("<script>12 hello!"), "scripthello");
  assert.equal(action("a".repeat(1000)).length, MAX_WORD_LENGTH);
  assert.throws(() => action("hi", { playerId: "two" }), /turn/);
  assert.throws(() => action("hi", { turnId: "old" }), /earlier/);
  assert.throws(() => action({}), /string/);
  submit("apple");
  assert.equal(game.typingText, "");
  setNow(game.turnEndsAt);
  assert.throws(() => service.updateTyping(game, { playerId: "two", text: "elephant", turnId: game.turnId }), /expired/);
  assert.equal(game.typingText, "");
});

test("resuming shifts the server deadline without changing the turn, draft, or chain", () => {
  const { service, game, advance } = fixture();
  const turnId = game.turnId, deadline = game.turnEndsAt;
  service.updateTyping(game, { playerId: "one", text: "app", turnId });
  advance(45000);
  service.resume(game, 45000);
  assert.equal(game.turnEndsAt, deadline + 45000); assert.equal(game.turnId, turnId);
  assert.equal(game.typingText, "app"); assert.equal(service.expire(game, turnId), null);
  assert.throws(() => service.resume(game, -1));
});

test("removing the active player continues with the following seat and a fresh deadline", () => {
  const { service, game, advance } = fixture();
  const turnId = game.turnId;
  advance(5000);
  const outcome = service.removePlayer(game, "one");
  assert.equal(outcome.reason, "removed"); assert.equal(outcome.gameOver, false);
  assert.equal(game.players.length, 2); assert.equal(service.publicState(game).currentPlayerId, "two");
  assert.notEqual(game.turnId, turnId); assert.equal(game.turnEndsAt, 16000);
});

test("removing a seat before the current player preserves their turn, deadline and typing", () => {
  const { service, game, submit } = fixture();
  submit("apple");
  const turnId = game.turnId, deadline = game.turnEndsAt;
  service.updateTyping(game, { playerId: "two", text: "ele", turnId });
  service.removePlayer(game, "one");
  assert.equal(game.currentTurnIndex, 0); assert.equal(service.publicState(game).currentPlayerId, "two");
  assert.equal(game.turnId, turnId); assert.equal(game.turnEndsAt, deadline); assert.equal(game.typingText, "ele");
  assert.equal(service.removePlayer(game, "unknown"), null);
  const outcome = service.removePlayer(game, "three");
  assert.equal(outcome.gameOver, true); assert.equal(game.winnerId, "two");
});
