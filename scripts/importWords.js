const fs = require("fs");
const path = require("path");
const { createDatabase, databasePath } = require("../src/database/connection");
const { runMigrations } = require("../src/database/migrate");
const { SqliteWordRepository } = require("../src/repositories/SqliteWordRepository");
const { WORD_CHAIN_CONFIG } = require("../src/config/wordChain");

const flatWordListSource = path.resolve(__dirname, "../data/scowl-60-en-us.txt");
const legacyScowlDirectory = path.resolve(__dirname, "../data/scowl-source/final");
const suppliedSource = process.argv.find((argument) => argument.startsWith("--source="));
const sourcePath = suppliedSource
  ? path.resolve(process.cwd(), suppliedSource.slice("--source=".length))
  : fs.existsSync(legacyScowlDirectory)
    ? legacyScowlDirectory
    : flatWordListSource;

if (!fs.existsSync(sourcePath)) {
  console.error(`SCOWL source file not found: ${sourcePath}`);
  console.error("Create it from ESDB size 60 American English with:");
  console.error("  ./scowl --db scowl.db word-list 60 A 1 --deaccent --wo-poses=abbr --categories= > scowl-60-en-us.txt");
  console.error("Then run: npm run import-words -- --source=/path/to/scowl-60-en-us.txt");
  process.exit(1);
}

function normalizeSourceWord(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  // The exported SCOWL list is one word per line. Keep only lowercase ASCII words
  // to reject proper names, abbreviations, punctuation, numbers, and compounds.
  if (trimmed !== trimmed.toLowerCase()) return null;
  if (!/^[a-z]+$/.test(trimmed)) return null;
  if (trimmed.length < WORD_CHAIN_CONFIG.minWordLength) return null;
  return trimmed;
}

function sourceFiles(inputPath) {
  if (!fs.statSync(inputPath).isDirectory()) return [inputPath];
  // SCOWLv1 has one incremental file per size. Combining 10 through 60 is
  // equivalent to its general-vocabulary size-60 dictionary.
  return fs
    .readdirSync(inputPath)
    .map((name) => ({ name, match: /^english-words\.(\d+)$/.exec(name) }))
    .filter(({ match }) => match && Number(match[1]) <= 60)
    .sort((first, second) => Number(first.match[1]) - Number(second.match[1]))
    .map(({ name }) => path.join(inputPath, name));
}

const entries = new Set();
for (const inputFile of sourceFiles(sourcePath)) {
  const source = fs.readFileSync(inputFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const word = normalizeSourceWord(line);
    if (word) entries.add(word);
  }
}

if (entries.size === 0) {
  console.error("No playable words were found. Use a flat SCOWL/ESDB word-list export.");
  process.exit(1);
}

const database = createDatabase();
runMigrations(database);
const wordRepository = new SqliteWordRepository(database);
wordRepository.clearWords();

database.exec("BEGIN");
try {
  for (const word of entries) wordRepository.insertWord(word);
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}

console.log(`Imported ${entries.size.toLocaleString()} SCOWL words into ${databasePath}.`);
