const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dataDirectory = path.resolve(__dirname, "../../data");
const databasePath = process.env.WORD_CHAIN_DB_PATH || path.join(dataDirectory, "word-chain.sqlite");

function createDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  return database;
}

module.exports = { createDatabase, databasePath };
