const test = require("node:test");
const assert = require("node:assert/strict");
const { ColorCardGame, normalizeHex, hexToRgb, colorDistance, MAX_RGB_DISTANCE } = require("../src/services/ColorCardGame");
const { roomOptions } = require("../src/config/gameModes");

const players = [{ id: "one", username: "One" }, { id: "two", username: "Two" }, { id: "three", username: "Three" }];

test("room options register both modes and enforce integer player limits", () => {
  assert.deepEqual(roomOptions(), { gameMode: "word-duel", maxPlayers: 2 });
  for (const gameMode of ["word-duel", "color-card"]) {
    for (const maxPlayers of [2, 3, 8]) assert.equal(roomOptions({ gameMode, maxPlayers }).maxPlayers, maxPlayers);
    for (const maxPlayers of [1, 9, 2.5, "invalid", null]) assert.throws(() => roomOptions({ gameMode, maxPlayers }));
  }
  for (const gameMode of ["unknown", "__proto__", null]) assert.throws(() => roomOptions({ gameMode }));
});

test("HEX parsing, RGB Euclidean distance and accuracy endpoints", () => {
  assert.equal(normalizeHex("#a34f2e"), "#A34F2E");
  assert.deepEqual(hexToRgb("#A34F2E"), [163, 79, 46]);
  assert.equal(colorDistance("#000000", "#030400"), 5);
  assert.equal(colorDistance("#FFFFFF", "#000000"), MAX_RGB_DISTANCE);
  for (const value of ["#123", "A34F2E", "#GGGGGG", "#12345678", {}, null, " #123456"]) assert.throws(() => normalizeHex(value));
});

test("closest colors share wins using full precision; missing guesses auto-submit their draft", () => {
  let now = 100;
  const game = new ColorCardGame({ now: () => now, randomColor: () => "#000000" });
  const round = game.start(players);
  now = round.memorizeEndsAt;
  game.submit(round, { playerId: "one", hex: "#030400", roundId: round.id });
  game.submit(round, { playerId: "two", hex: "#000005", roundId: round.id });
  const result = game.finish(round, "timeout");
  assert.deepEqual(result.winnerIds, ["one", "two"]);
  assert.deepEqual(result.entries.map((entry) => entry.distance), [5, 5, MAX_RGB_DISTANCE]);
  assert.equal(result.entries[2].accuracy, 0);
  assert.equal(result.entries[2].submittedColor, "#FFFFFF");
  assert.equal(result.entries[2].autoSubmitted, true);
  assert.equal(game.finish(round, "again"), result);
  assert.throws(() => game.submit(round, { playerId: "three", hex: "#000000", roundId: round.id }), /no longer/);
});

test("rejects invalid, outsider, stale and late answers; submitted colors can be edited", () => {
  let now = 1_000;
  const game = new ColorCardGame({ now: () => now });
  const round = game.start(players);
  const submit = (changes) => game.submit(round, { playerId: "one", hex: "#123456", roundId: round.id, ...changes });
  assert.throws(() => submit({ playerId: "outsider" }), /not in/);
  assert.throws(() => submit({ roundId: "old-round" }), /another round/);
  assert.throws(() => submit({}), /Memorize the target first/);
  assert.equal(round.submissions.size, 0);
  now = round.memorizeEndsAt;
  assert.throws(() => submit({ hex: "bad" }), /six-digit/);
  assert.equal(round.submissions.size, 0);
  submit();
  submit({ hex: "#FFFFFF" });
  assert.equal(round.submissions.get("one"), "#FFFFFF");
  game.edit(round, { playerId: "one", roundId: round.id });
  assert.equal(round.submissions.size, 0);
  game.updateDraft(round, { playerId: "one", roundId: round.id, hex: "#112233" });
  now = round.endsAt;
  assert.throws(() => submit({ playerId: "two" }), /expired/);
  const result = game.finish(round, "timeout");
  assert.equal(result.entries.find((entry) => entry.id === "one").submittedColor, "#112233");
  assert.ok(result.entries.every((entry) => entry.autoSubmitted));
});

test("untouched cards auto-submit white; black/white accuracy is bounded", () => {
  let now = 100;
  const game = new ColorCardGame({ now: () => now, randomColor: () => "#000000" });
  const empty = game.finish(game.start(players), "timeout");
  assert.deepEqual(empty.winnerIds, players.map((player) => player.id));
  assert.ok(empty.entries.every((entry) => entry.submittedColor === "#FFFFFF" && entry.autoSubmitted));
  const round = game.start(players);
  now = round.memorizeEndsAt;
  game.submit(round, { playerId: "one", hex: "#000000", roundId: round.id });
  game.submit(round, { playerId: "two", hex: "#FFFFFF", roundId: round.id });
  const result = game.finish(round, "timeout");
  assert.equal(result.entries[0].accuracy, 100);
  assert.equal(result.entries[1].accuracy, 0);
});

test("host durations allow only 30, 45, and 60 seconds after memorization", () => {
  const game = new ColorCardGame({ now: () => 100 });
  for (const durationSeconds of [30, 45, 60]) {
    const round = game.start(players, { durationSeconds });
    assert.equal(round.endsAt - round.memorizeEndsAt, durationSeconds * 1000);
    assert.equal(roomOptions({ gameMode: "color-card", colorDuration: durationSeconds }).colorDuration, durationSeconds);
  }
  for (const durationSeconds of [0, 15, 31, 90, null]) assert.throws(() => game.start(players, { durationSeconds }));
});

test("five shared cards produce cumulative standings and stop after the fifth", () => {
  let now = 100;
  let colorIndex = 0;
  const targets = ["#112233", "#445566", "#778899", "#AABBCC", "#DDEEFF"];
  const game = new ColorCardGame({ now: () => now, randomColor: () => targets[colorIndex++] });
  const match = game.createMatch(players, 45);
  assert.deepEqual(match.targets, targets);
  let summary;
  for (let index = 0; index < 5; index += 1) {
    const round = game.startNext(match);
    assert.equal(round.targetColor, targets[index]);
    assert.equal(round.durationSeconds, 45);
    assert.throws(() => game.startNext(match), /Finish the current/);
    now = round.memorizeEndsAt;
    game.submit(round, { playerId: "one", roundId: round.id, hex: targets[index] });
    const result = game.finish(round, "timeout");
    summary = game.recordResult(match, result);
    game.recordResult(match, result);
    assert.equal(match.history.length, index + 1);
    assert.equal(summary.roundNumber, index + 1);
    assert.equal(summary.matchComplete, index === 4);
  }
  assert.equal(summary.standings[0].averageAccuracy, 100);
  assert.deepEqual(summary.matchWinnerIds, ["one"]);
  assert.throws(() => game.startNext(match), /All cards/);
});

test("custom card counts produce unique valid HEX targets, even when randomness collides", () => {
  const game = new ColorCardGame({ randomColor: () => "#FFFFFF" });
  for (const count of [1, 3, 10, 100]) {
    const match = game.createMatch(players, 30, count);
    assert.equal(match.targets.length, count);
    assert.equal(new Set(match.targets).size, count);
    assert.ok(match.targets.every((color) => /^#[0-9A-F]{6}$/.test(color)));
    assert.equal(roomOptions({ gameMode: "color-card", colorCardCount: count }).colorCardCount, count);
  }
  for (const count of [0, -1, 101, 1.5, null, "bad"]) assert.throws(() => game.createMatch(players, 30, count));
});
