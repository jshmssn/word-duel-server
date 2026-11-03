const test = require("node:test");
const assert = require("node:assert/strict");
const { FinishWordGame, MAX_WORD_LENGTH } = require("../src/services/FinishWordGame");

const players = [
  { id: "one", username: "One", characterId: "knight" },
  { id: "two", username: "Two", characterId: "wizard" },
  { id: "three", username: "Three", characterId: "ninja" },
];

function fixture({ count = 3, random = () => 0, chooseLetter = true, words = ["apple", "elephant", "turtle", "eagle", "echo", "orange", "at", "tea", "tape", "pearl", "ring"] } = {}) {
  let now = 1000;
  const queries = [];
  const dictionary = new Set(words);
  const service = new FinishWordGame({ isValidWord: (word) => { queries.push(word); return dictionary.has(word); }, now: () => now, random, randomIndex: () => 0, randomPlayerIndex: () => 0,
    getStartingPrefixes: (length, used = new Set()) => [...new Set(words.filter((word) => word.length >= 2 && word.length <= 64 && !used.has(word)).map((word) => word.slice(0, length)))] });
  const game = service.start(players.slice(0, count));
  if (chooseLetter) service.chooseStartingLetter(game, { playerId: players[0].id, turnId: game.turnId, letter: game.startingLetterChoices.includes("a") ? "a" : game.startingLetterChoices[0] });
  const submit = (word, changes = {}) => service.submit(game, { playerId: game.players[game.currentTurnIndex]?.id, word, turnId: game.turnId, ...changes });
  return { service, game, submit, queries, setNow: (value) => { now = value; }, advance: (value) => { now += value; } };
}

test("a match starts with three lives, a server deadline, unique turn ID and safe public snapshots", () => {
  const { service, game } = fixture();
  const state = service.publicState(game);
  assert.equal(state.gameMode, "finish-word");
  assert.equal(state.status, "PLAYING"); assert.equal(state.currentPlayerId, "one");
  assert.equal(state.turnDuration, 15); assert.equal(state.turnEndsAt, 16000);
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

test("each new round draws a starting player and keeps the normal circular turn order", () => {
  const choices = [2, 0, 1];
  const service = new FinishWordGame({ isValidWord: () => true, getStartingPrefixes: () => ["a", "e", "t", "b"], randomIndex: () => 0,
    randomPlayerIndex: (count) => { assert.equal(count, players.length); return choices.shift(); } });
  for (const expectedIndex of [2, 0, 1]) {
    const game = service.start(players);
    service.chooseStartingLetter(game, { playerId: players[expectedIndex].id, turnId: game.turnId, letter: "a" });
    assert.equal(game.currentTurnIndex, expectedIndex);
    assert.deepEqual(game.players.map((player) => player.id), players.map((player) => player.id));
    service.submit(game, { playerId: players[expectedIndex].id, turnId: game.turnId, word: "apple" });
    assert.equal(game.currentTurnIndex, (expectedIndex + 1) % players.length);
  }
});

test("only the first player receives four valid choices and selection is immutable without resetting the deadline", () => {
  const { service, game, submit, queries, advance } = fixture({ chooseLetter: false });
  const own = service.publicState(game, "one");
  assert.equal(own.awaitingStartingLetterChoice, true);
  assert.equal(own.requiredPrefix, null);
  assert.equal(new Set(own.startingLetterChoices).size, 4);
  assert.ok(own.startingLetterChoices.every((letter) => service.getStartingPrefixes(1).includes(letter)));
  assert.deepEqual(service.publicState(game, "two").startingLetterChoices, []);
  assert.deepEqual(service.publicState(game).startingLetterChoices, []);
  assert.throws(() => submit("apple"), /Choose a starting letter/);
  assert.deepEqual(queries, []);
  const action = { playerId: "one", turnId: game.turnId, letter: "a" };
  assert.throws(() => service.chooseStartingLetter(game, { ...action, playerId: "two" }), /turn/);
  assert.throws(() => service.chooseStartingLetter(game, { ...action, turnId: "stale" }), /earlier/);
  assert.throws(() => service.chooseStartingLetter(game, { ...action, letter: "z" }), /Choose one/);
  const deadline = game.turnEndsAt;
  advance(2000);
  service.chooseStartingLetter(game, action);
  assert.equal(game.requiredPrefix, "a");
  assert.equal(game.turnEndsAt, deadline);
  assert.throws(() => service.chooseStartingLetter(game, { ...action, letter: "e" }), /locked/);
  assert.equal(submit("apple").accepted, true);
  assert.equal(game.awaitingStartingLetterChoice, false);
  assert.deepEqual(game.startingLetterChoices, []);
});

test("an unanswered opening choice times out normally and subsequent players do not get choices", () => {
  const { service, game, setNow } = fixture({ chooseLetter: false });
  setNow(game.turnEndsAt);
  assert.throws(() => service.chooseStartingLetter(game, { playerId: "one", turnId: game.turnId, letter: "a" }), /expired/);
  service.expire(game, game.turnId);
  assert.equal(game.players[0].lives, 2);
  assert.equal(game.currentTurnIndex, 1);
  assert.equal(game.awaitingStartingLetterChoice, false);
  assert.equal(game.requiredPrefix.length, 1);
});

for (const length of [1, 2]) {
  test(`ONYX falls back from an impossible ${length}-letter suffix to an unused dictionary prefix`, () => {
    const words = ["onyx", "apple", "stone", "brave"];
    const { service, game, submit } = fixture({ words, chooseLetter: false });
    service.chooseStartingLetter(game, { playerId: "one", turnId: game.turnId, letter: "o" });
    game.hardModeAfter = length === 2 ? 1 : 10;
    assert.equal(submit("onyx").accepted, true);
    assert.equal(game.requiredPrefix.length, length);
    assert.notEqual(game.requiredPrefix, length === 2 ? "yx" : "x");
    assert.ok(words.some((word) => !game.usedWordsSet.has(word) && word.startsWith(game.requiredPrefix)));
    assert.equal(game.lastWord, "onyx");
    assert.equal(game.currentTurnIndex, 1);
  });
}

test("the first ten accepted words use one letter, then every new turn gets an independent 60/40 roll", () => {
  const chain = ["apple", "elephant", "turtle", "eagle", "echo", "orange", "egg", "goat", "tea", "all"];
  const rolls = [0.599, 0.6, 0.1, 0.9, 0.2, 0.3];
  let calls = 0;
  const { service, game, submit, setNow } = fixture({ words: [...chain, "llama", "mall", "ant", "axe"], random: () => rolls[calls++] });
  for (let index = 0; index < chain.length; index++) {
    assert.equal(game.requiredPrefix.length, 1);
    assert.equal(calls, 0);
    assert.equal(submit(chain[index]).accepted, true);
  }
  assert.equal(game.successfulTurns, 10);
  assert.equal(game.requiredPrefix, "ll");
  assert.equal(calls, 1);
  assert.equal(submit("llzzzz").accepted, false);
  assert.equal(game.successfulTurns, 10);
  assert.equal(calls, 1);
  assert.equal(submit("llama").accepted, true);
  assert.equal(game.requiredPrefix.length, 1);
  for (const length of [2, 1, 2, 2]) {
    setNow(game.turnEndsAt); service.expire(game, game.turnId);
    assert.equal(game.requiredPrefix.length, length);
    assert.equal(game.successfulTurns, 11);
    assert.ok(service.getStartingPrefixes(length, game.usedWordsSet).includes(game.requiredPrefix));
  }
  assert.equal(calls, 6);
});

test("the difficulty boundary assigns two letters to exactly 60 of 100 equally spaced random draws", () => {
  let draw = 0;
  const { service, game } = fixture({ random: () => draw / 100 });
  game.successfulTurns = 10;
  const counts = { 1: 0, 2: 0 };
  for (draw = 0; draw < 100; draw++) { service.assignNextPrefix(game); counts[game.requiredPrefix.length]++; }
  assert.deepEqual(counts, { 1: 40, 2: 60 });
});

test("a fully exhausted dictionary ends the match instead of assigning an impossible prefix", () => {
  const { game, submit } = fixture({ words: ["apple", "elephant"] });
  assert.equal(submit("apple").accepted, true);
  const outcome = submit("elephant");
  assert.equal(outcome.accepted, true); assert.equal(outcome.gameOver, true);
  assert.equal(game.status, "ENDED"); assert.equal(game.endReason, "dictionary_exhausted");
  assert.equal(game.requiredPrefix, null); assert.equal(game.turnId, null);
  assert.ok(game.players.every((player) => player.lives === 3));
});

test("all submission whitespace is removed before dictionary, prefix and duplicate validation", () => {
  const { game, submit, queries } = fixture();
  assert.equal(submit(" \tA p\np\rl\u00a0e\u2003 ").accepted, true);
  assert.deepEqual(queries, ["apple"]);
  assert.equal(game.lastWord, "apple");
  assert.equal(submit("e l e p h a n t").accepted, true);
  assert.equal(game.requiredPrefix, "t");
  game.requiredPrefix = "a";
  assert.equal(submit(" A P P L E ").reason, "already_used");
  assert.equal(game.players[2].lives, 3);
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
  test(`invalid submission (${reason}) allows a retry without changing the turn or deadline`, () => {
    const { service, game, submit, queries, advance } = fixture();
    advance(4000);
    const before = service.publicState(game);
    const outcome = submit(word);
    assert.equal(outcome.accepted, false); assert.equal(outcome.reason, reason);
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.playerId, "one"); assert.deepEqual(outcome.eliminatedPlayerIds, []);
    assert.deepEqual(service.publicState(game), before);
    assert.equal(game.requiredPrefix, "a"); assert.equal(game.lastWord, null);
    assert.equal(game.usedWordsSet.size, 0);
    if (reason !== "not_in_dictionary") assert.equal(queries.length, 0);
    advance(10999);
    assert.equal(submit("apple").accepted, true, "a valid retry works until the original deadline");
    assert.equal(game.players[0].lives, 3); assert.equal(game.currentTurnIndex, 1);
  });
}

test("oversized invalid words preserve the turn without retaining or broadcasting the oversized payload", () => {
  const { service, game, submit, queries } = fixture();
  const outcome = submit("A".repeat(200000));
  assert.equal(outcome.accepted, false); assert.equal(outcome.reason, "invalid_format");
  assert.equal(game.players[0].lives, 3); assert.equal(game.currentTurnIndex, 0);
  assert.equal(outcome.word.length, MAX_WORD_LENGTH);
  assert.deepEqual(service.publicState(game).history, []);
  assert.equal(queries.length, 0); assert.equal(game.usedWordsSet.size, 0);
  assert.equal(game.lastWord, null);
});

test("a used word is rejected case-insensitively for the rest of the match", () => {
  const { game, submit } = fixture();
  submit("at"); submit("tea");
  const outcome = submit("AT");
  assert.equal(outcome.reason, "already_used");
  assert.equal(game.players[2].lives, 3);
  assert.equal(game.currentTurnIndex, 2);
  assert.equal(submit("apple").accepted, true);
  assert.equal(game.lastWord, "apple"); assert.equal(game.usedWordsSet.size, 3);
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

test("repeated invalid attempts clear the draft and cannot extend the timeout or prevent elimination", () => {
  const { service, game, submit, advance, setNow } = fixture({ count: 2 });
  game.players[0].lives = 1;
  const turnId = game.turnId, deadline = game.turnEndsAt;
  service.updateTyping(game, { playerId: "one", text: "azzzz", turnId });
  for (let index = 0; index < 5; index++) {
    advance(1000);
    assert.equal(submit("azzzz").retryable, true);
    assert.equal(game.turnId, turnId); assert.equal(game.turnEndsAt, deadline);
    assert.equal(game.typingText, ""); assert.equal(game.players[0].lives, 1);
  }
  setNow(deadline);
  const outcome = submit("apple");
  assert.equal(outcome.reason, "timeout"); assert.equal(outcome.gameOver, true);
  assert.deepEqual(outcome.eliminatedPlayerIds, ["one"]);
  assert.equal(game.winnerId, "two");
  assert.equal(service.expire(game, turnId), null);
});

test("a full cycle of timeouts chooses new letters and keeps used words and hard-mode progress", () => {
  let now = 0;
  const service = new FinishWordGame({ isValidWord: () => true, now: () => now,
    random: () => 0, randomIndex: () => 0, randomPlayerIndex: () => 0,
    getStartingPrefixes: (length) => length === 2 ? ["le", "br"] : ["a", "e", "b"] });
  for (const hardModeAfter of [1, 10]) {
    const game = service.start(players, { hardModeAfter });
    service.chooseStartingLetter(game, { playerId: "one", turnId: game.turnId, letter: "a" });
    service.submit(game, { playerId: "one", word: "apple", turnId: game.turnId });
    const prefix = game.requiredPrefix;
    for (let turn = 0; turn < 3; turn++) {
      now = game.turnEndsAt;
      const outcome = service.expire(game, game.turnId);
      if (turn < 2) { assert.equal(game.requiredPrefix, prefix); assert.equal(outcome.prefixChanged, undefined); }
      else { assert.equal(outcome.prefixChanged, true); assert.match(outcome.message, /Nobody found a word/); }
    }
    assert.equal(game.requiredPrefix, hardModeAfter === 1 ? "br" : "a");
    assert.equal(game.lastWord, null); assert.equal(game.successfulTurns, 1);
    assert.deepEqual([...game.usedWordsSet], ["apple"]);
    assert.equal(game.turnEndsAt - now, 15000);
    assert.ok(game.players.every((player) => player.lives === 2));
  }
});

test("an accepted word restarts the failed-player cycle and eliminated seats are skipped", () => {
  const { service, game, submit, setNow } = fixture();
  const timeout = () => { setNow(game.turnEndsAt); return service.expire(game, game.turnId); };
  timeout();
  assert.equal(submit("apple").accepted, true);
  timeout(); timeout();
  assert.equal(game.requiredPrefix, "e", "earlier failures do not count after an accepted word");
  assert.equal(timeout().prefixChanged, true);
  assert.notEqual(game.requiredPrefix, "e");
  const other = fixture();
  const expireOther = () => { other.setNow(other.game.turnEndsAt); return other.service.expire(other.game, other.game.turnId); };
  other.game.players[0].lives = 1;
  assert.deepEqual(expireOther().eliminatedPlayerIds, ["one"]);
  const prefix = other.game.requiredPrefix;
  expireOther(); expireOther();
  assert.notEqual(other.game.requiredPrefix, prefix, "only remaining players need to time out");
});

test("eliminated players are skipped and the last survivor ends the match", () => {
  const { service, game, submit, setNow } = fixture({ count: 2 });
  const timeout = () => { setNow(game.turnEndsAt); return service.expire(game, game.turnId); };
  for (let round = 0; round < 2; round++) { timeout(); timeout(); }
  assert.ok(game.players.every((player) => player.lives === 1));
  const outcome = timeout();
  assert.deepEqual(outcome.eliminatedPlayerIds, ["one"]); assert.equal(outcome.gameOver, true);
  assert.equal(game.status, "ENDED"); assert.equal(game.winnerId, "two"); assert.equal(game.winnerName, "Two");
  assert.equal(game.turnId, null); assert.equal(game.turnEndsAt, null);
  assert.equal(service.publicState(game).currentPlayerId, null);
  assert.throws(() => submit("apple"), /ended/);
  assert.equal(service.expire(game, "old"), null);
});

test("surviving turns skip eliminated seats while retaining them in the scene", () => {
  const { service, game, submit, setNow } = fixture();
  const timeout = () => { setNow(game.turnEndsAt); return service.expire(game, game.turnId); };
  game.players[1].lives = 1;
  timeout();
  assert.deepEqual(timeout().eliminatedPlayerIds, ["two"]);
  assert.equal(service.publicState(game).currentPlayerId, "three");
  timeout();
  assert.equal(service.publicState(game).currentPlayerId, "one");
  assert.equal(game.players.length, 3);
  assert.throws(() => submit("apple", { playerId: "two" }), /eliminated/);
});

test("mixed difficulty begins after accepted words and replaces impossible suffixes with playable prefixes", () => {
  const { service, game, submit } = fixture();
  game.hardModeAfter = 2;
  submit("apple");
  assert.equal(game.requiredPrefix, "e"); assert.equal(service.publicState(game).hardMode, false);
  submit("elephant");
  assert.equal(game.requiredPrefix, "tu"); assert.equal(service.publicState(game).hardMode, true);
  assert.equal(submit("turtle").accepted, true);
  assert.notEqual(game.requiredPrefix, "le");
  assert.ok(service.getStartingPrefixes(2, game.usedWordsSet).includes(game.requiredPrefix));
});

test("hard mode accepts a real two-letter continuation and carries its new suffix forward", () => {
  const { game, submit } = fixture();
  game.hardModeAfter = 1;
  submit("at");
  assert.notEqual(game.requiredPrefix, "at", "the only AT word has already been used");
  game.requiredPrefix = "ta";
  assert.equal(submit("tape").accepted, true);
  assert.equal(game.requiredPrefix, "pe");
  assert.equal(submit("pearl").accepted, true);
  assert.notEqual(game.requiredPrefix, "rl");
  assert.ok(game.requiredPrefix.length === 2);
});

test("an LL prompt rejects MALL and BALLOON and accepts LLAMA at the start", () => {
  const { service, game, submit, queries } = fixture({ words: ["all", "mall", "balloon", "llama"] });
  game.hardModeAfter = 1;
  assert.equal(submit("all").accepted, true);
  assert.equal(game.requiredPrefix, "ll");
  const before = service.publicState(game);
  for (const word of ["MALL", "balloon"]) {
    const rejected = submit(word);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "wrong_prefix");
    assert.equal(rejected.message, "Your word must start with LL.");
    assert.equal(rejected.retryable, true);
    assert.deepEqual(service.publicState(game), before);
  }
  assert.deepEqual(queries, ["all"]);
  assert.equal(submit("LLAMA").accepted, true);
  assert.equal(game.requiredPrefix, "ma");
  assert.ok(game.players.every((player) => player.lives === 3));
});

test("live typing is bounded, sanitized, turn-scoped and cleared when a turn changes", () => {
  const { service, game, submit, setNow } = fixture();
  const action = (text, changes = {}) => service.updateTyping(game, { playerId: "one", text, turnId: game.turnId, ...changes });
  assert.equal(action("AppLe"), "AppLe");
  assert.equal(service.publicState(game).typingText, "AppLe");
  assert.equal(action("a<script>12 hello!"), "ascripthello");
  assert.throws(() => action("wrongprefix"), /start with A/);
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
  assert.notEqual(game.turnId, turnId); assert.equal(game.turnEndsAt, 21000);
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
