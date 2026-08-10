const { createDatabase, databasePath } = require("../src/database/connection");
const { runMigrations } = require("../src/database/migrate");

const database = createDatabase();
runMigrations(database);
database.close();
console.log(`Database migrations complete: ${databasePath}`);
