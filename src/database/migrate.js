const fs = require("fs");
const path = require("path");

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDirectory = path.join(__dirname, "migrations");
  const appliedVersions = new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version),
  );

  const migrationFiles = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const fileName of migrationFiles) {
    if (appliedVersions.has(fileName)) continue;

    const sql = fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8");
    database.exec("BEGIN");
    try {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(fileName, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { runMigrations };
