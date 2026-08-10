class SqliteWordRepository {
  constructor(database) {
    this.database = database;
    this.findWordStatement = database.prepare("SELECT 1 FROM words WHERE word = ? LIMIT 1");
    this.insertWordStatement = database.prepare(`
      INSERT OR IGNORE INTO words
        (word, length, first_letter, first_two_letters, last_letter, last_two_letters)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  clearWords() {
    this.database.exec("DELETE FROM words");
  }

  insertWord(word) {
    const entry = String(word).toLowerCase();
    return this.insertWordStatement.run(
      entry,
      entry.length,
      entry[0],
      entry.slice(0, 2),
      entry.at(-1),
      entry.slice(-2),
    );
  }

  wordExists(word) {
    return Boolean(this.findWordStatement.get(word));
  }

  hasUnusedWordForPrefix({ gameId, prefix }) {
    const normalizedPrefix = String(prefix || "").toLowerCase();
    if (normalizedPrefix.length !== 1 && normalizedPrefix.length !== 2) return false;

    const column = normalizedPrefix.length === 1 ? "first_letter" : "first_two_letters";
    const result = this.database
      .prepare(`
        SELECT EXISTS(
          SELECT 1
          FROM words AS word
          WHERE word.${column} = ?
            AND NOT EXISTS (
              SELECT 1
              FROM game_words AS used_word
              WHERE used_word.game_id = ?
                AND used_word.word = word.word
            )
          LIMIT 1
        ) AS available
      `)
      .get(normalizedPrefix, gameId);

    return result.available === 1;
  }

  getStartingLetters({ gameId, minimumAvailableWords }) {
    return this.database
      .prepare(`
        SELECT word.first_letter AS letter, COUNT(*) AS available_words
        FROM words AS word
        WHERE NOT EXISTS (
          SELECT 1
          FROM game_words AS used_word
          WHERE used_word.game_id = ?
            AND used_word.word = word.word
        )
        GROUP BY word.first_letter
        HAVING COUNT(*) >= ?
        ORDER BY word.first_letter ASC
      `)
      .all(gameId, minimumAvailableWords)
      .map((row) => row.letter);
  }

  getWordCount() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM words").get().count;
  }
}

module.exports = { SqliteWordRepository };
