const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const Database = require("better-sqlite3");

const serverDirectory = path.resolve(__dirname, "../..");
const defaultDatabasePath = path.join(serverDirectory, "data/finish-word.sqlite");

function defaultSourcePath() {
  const candidates = [path.join(serverDirectory, "clean-words.txt"), path.join(serverDirectory, "../clean-words.txt")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function normalizeWord(word) {
  return typeof word === "string" ? word.trim().toLowerCase() : "";
}

// Iterate over lines without creating a second array containing the dictionary.
function* dictionaryLines(source) {
  let from = 0;
  let lineNumber = 0;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline === -1 ? source.length : newline;
    lineNumber += 1;
    yield { word: normalizeWord(source.slice(from, to)), lineNumber };
    if (newline === -1) break;
    from = newline + 1;
  }
}

function initializeSchema(database) {
  const existingColumns = database.pragma("table_info(words)");
  if (existingColumns.length && (existingColumns.length !== 1 || existingColumns[0].name !== "word")) {
    throw new Error("Finish the Word requires its own database with a single-column words table. Set FINISH_WORD_DB_PATH to a separate SQLite file.");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS words (
      word TEXT PRIMARY KEY CHECK (length(word) > 0 AND word = lower(word) AND word NOT GLOB '*[^a-z]*')
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS dictionary_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  // New tables are indexed by their primary key. Existing compatible tables
  // without a primary key receive the equivalent unique lookup index.
  if (existingColumns.length && !existingColumns[0].pk) database.exec("CREATE UNIQUE INDEX IF NOT EXISTS words_word_idx ON words(word)");
}

function importDictionary(database, filePath, { force = false } = {}) {
  const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const digest = createHash("sha256").update(source).digest("hex");
  const previousDigest = database.prepare("SELECT value FROM dictionary_metadata WHERE key = 'source_sha256'").get()?.value;
  const previousCount = database.prepare("SELECT COUNT(*) AS count FROM words").get().count;
  if (!force && previousDigest === digest && previousCount > 0) {
    return { imported: false, count: previousCount, sourceSha256: digest };
  }
  const insert = database.prepare("INSERT OR IGNORE INTO words (word) VALUES (?)");
  const writeMetadata = database.prepare("INSERT INTO dictionary_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const replace = database.transaction(() => {
    database.prepare("DELETE FROM words").run();
    let nonemptyLines = 0;
    for (const { word, lineNumber } of dictionaryLines(source)) {
      if (!word) continue;
      if (!/^[a-z]+$/.test(word)) throw new Error(`Invalid dictionary entry at line ${lineNumber}: use one alphabetic English word per line.`);
      insert.run(word);
      nonemptyLines += 1;
    }
    const count = database.prepare("SELECT COUNT(*) AS count FROM words").get().count;
    if (!count) throw new Error("The dictionary file contains no words. The previous dictionary was preserved.");
    writeMetadata.run("source_sha256", digest);
    writeMetadata.run("source_path", path.resolve(filePath));
    writeMetadata.run("imported_at", new Date().toISOString());
    return { imported: true, count, duplicateLines: nonemptyLines - count, sourceSha256: digest };
  });
  return replace.immediate();
}

function createFinishWordDictionary(options = {}) {
  const configuredSource = options.filePath || process.env.FINISH_WORDS_FILE;
  const filePath = path.resolve(configuredSource || defaultSourcePath());
  const configuredDatabase = options.databasePath || process.env.FINISH_WORD_DB_PATH || defaultDatabasePath;
  const databasePath = configuredDatabase === ":memory:" ? configuredDatabase : path.resolve(configuredDatabase);
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    initializeSchema(database);
    let importResult;
    if (fs.existsSync(filePath)) importResult = importDictionary(database, filePath, { force: options.force });
    else {
      const count = database.prepare("SELECT COUNT(*) AS count FROM words").get().count;
      const seeded = database.prepare("SELECT value FROM dictionary_metadata WHERE key = 'source_sha256'").get();
      if (configuredSource || !count || !seeded) {
        throw new Error(`Dictionary file not found: ${filePath}. Supply clean-words.txt or set FINISH_WORDS_FILE before starting Finish the Word.`);
      }
      importResult = { imported: false, count, sourceSha256: seeded.value };
    }
    const findWord = database.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1");
    return {
      ...importResult,
      filePath,
      databasePath,
      isValidWord(word) {
        const normalized = normalizeWord(word);
        return /^[a-z]+$/.test(normalized) && Boolean(findWord.get(normalized));
      },
      close() { if (database.open) database.close(); },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = { createFinishWordDictionary, importDictionary, normalizeWord, defaultDatabasePath, defaultSourcePath };
