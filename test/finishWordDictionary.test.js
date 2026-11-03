const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createFinishWordDictionary } = require("../src/services/FinishWordDictionary");
const { parseArguments } = require("../scripts/importFinishWords");

function fixture(t, source = "Apple\r\nelephant\r\nTURTLE\r\napple\r\n\r\na\n") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finish-word-dictionary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "clean-words.txt");
  fs.writeFileSync(filePath, source);
  return { filePath, databasePath: path.join(directory, "dictionary.sqlite") };
}

test("imports lowercase unique words and uses an indexed single-column table", (t) => {
  const options = fixture(t);
  const dictionary = createFinishWordDictionary(options);
  try {
    assert.equal(dictionary.imported, true);
    assert.equal(dictionary.count, 4);
    assert.equal(dictionary.isValidWord("APPLE"), true);
    assert.equal(dictionary.isValidWord(" elephant "), true);
    assert.equal(dictionary.isValidWord("elephants"), false);
    assert.deepEqual(dictionary.getStartingPrefixes(1).sort(), ["a", "e", "t"]);
    assert.deepEqual(dictionary.getStartingPrefixes(2).sort(), ["ap", "el", "tu"]);
    const prefixes = dictionary.getStartingPrefixes(1); prefixes.pop();
    assert.equal(dictionary.getStartingPrefixes(1).length, 3, "prefix snapshots cannot mutate the cache");
    for (const invalid of [null, {}, "", "app", "apple' OR 1=1--", "two words"]) assert.equal(dictionary.isValidWord(invalid), false);
    const database = new Database(options.databasePath, { readonly: true });
    try {
      assert.deepEqual(database.pragma("table_info(words)").map((column) => column.name), ["word"]);
      assert.deepEqual(database.prepare("SELECT word FROM words ORDER BY word").all().map((row) => row.word), ["a", "apple", "elephant", "turtle"]);
      const query = database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM words WHERE word = ? LIMIT 1").all("apple");
      assert.match(query[0].detail, /SEARCH words USING (COVERING INDEX|PRIMARY KEY)/);
    } finally { database.close(); }
  } finally { dictionary.close(); }
});

test("playable prefix lists exclude used words, single-character entries and oversized words", (t) => {
  const dictionary = createFinishWordDictionary(fixture(t, `a\napple\nape\nonyx\nstone\nbrave\n${"z".repeat(65)}\n`));
  try {
    assert.deepEqual(dictionary.getStartingPrefixes(1).sort(), ["a", "b", "o", "s"]);
    assert.ok(dictionary.getStartingPrefixes(2, new Set(["apple"])).includes("ap"));
    assert.ok(!dictionary.getStartingPrefixes(2, new Set(["apple", "ape"])).includes("ap"));
    assert.deepEqual(dictionary.getStartingPrefixes(1, new Set(["apple", "ape", "onyx", "stone", "brave"])), []);
    assert.ok(!dictionary.getStartingPrefixes(2).includes("yx"));
  } finally { dictionary.close(); }
});

test("unchanged files are idempotent and a changed file atomically replaces old words", (t) => {
  const options = fixture(t);
  let dictionary = createFinishWordDictionary(options);
  const digest = dictionary.sourceSha256;
  dictionary.close();
  dictionary = createFinishWordDictionary(options);
  assert.equal(dictionary.imported, false);
  assert.equal(dictionary.sourceSha256, digest);
  dictionary.close();
  fs.writeFileSync(options.filePath, "BANANA\nanimal\n");
  dictionary = createFinishWordDictionary(options);
  try {
    assert.equal(dictionary.imported, true);
    assert.equal(dictionary.count, 2);
    assert.notEqual(dictionary.sourceSha256, digest);
    assert.equal(dictionary.isValidWord("banana"), true);
    assert.equal(dictionary.isValidWord("apple"), false);
  } finally { dictionary.close(); }
});

test("invalid or empty replacement files roll back the previous dictionary", (t) => {
  const options = fixture(t);
  createFinishWordDictionary(options).close();
  for (const source of ["valid\nnot-a-word\n", "\n  \n"]) {
    fs.writeFileSync(options.filePath, source);
    assert.throws(() => createFinishWordDictionary(options), /Invalid dictionary entry|contains no words/);
    const database = new Database(options.databasePath, { readonly: true });
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM words").get().count, 4); }
    finally { database.close(); }
  }
});

test("missing explicit source and an incompatible words schema fail clearly", (t) => {
  const options = fixture(t);
  fs.unlinkSync(options.filePath);
  assert.throws(() => createFinishWordDictionary(options), /Dictionary file not found/);
  const database = new Database(options.databasePath);
  database.exec("DROP TABLE words; CREATE TABLE words (word TEXT, length INTEGER)");
  database.close();
  assert.throws(() => createFinishWordDictionary(options), /own database/);
});

test("UTF-8 BOM and LF files import correctly and command arguments are validated", (t) => {
  const dictionary = createFinishWordDictionary(fixture(t, "\uFEFFApple\nBOAT\n"));
  try { assert.equal(dictionary.count, 2); assert.equal(dictionary.isValidWord("boat"), true); }
  finally { dictionary.close(); }
  assert.deepEqual(parseArguments(["--file", "words.txt", "--db", "game.sqlite", "--check", "apple", "--force"]), { filePath: "words.txt", databasePath: "game.sqlite", check: "apple", force: true });
  assert.throws(() => parseArguments(["--file"]), /missing option/);
});
