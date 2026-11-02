const path = require("node:path");
const { createFinishWordDictionary } = require("../src/services/FinishWordDictionary");

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--force") { options.force = true; continue; }
    const key = { "--file": "filePath", "--db": "databasePath", "--check": "check" }[argument];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown or missing option: ${argument}. Use --help for usage.`);
    options[key] = args[++index];
  }
  return options;
}

function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log("Usage: node scripts/importFinishWords.js [--file path/to/clean-words.txt] [--db path/to/finish-word.sqlite] [--force] [--check apple]");
    return;
  }
  const dictionary = createFinishWordDictionary(options);
  try {
    console.log(`${dictionary.imported ? "Imported" : "Ready"}: ${dictionary.count.toLocaleString("en-US")} words in ${path.resolve(dictionary.databasePath)}`);
    if (options.check !== undefined) {
      const valid = dictionary.isValidWord(options.check);
      console.log(JSON.stringify({ word: options.check, isValidWord: valid }));
    }
  } finally { dictionary.close(); }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, parseArguments };
