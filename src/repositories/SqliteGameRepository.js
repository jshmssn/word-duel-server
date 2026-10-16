function parseStartingLetters(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

class SqliteGameRepository {
  constructor(database) {
    this.database = database;
  }

  create(game) {
    this.database
      .prepare(`
        INSERT INTO games (
          id, room_code, mode, status, required_prefix, starting_letters,
          current_player_id, last_word, invalid_attempts, turn_ends_at,
          created_at, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        game.id,
        game.roomCode,
        game.mode,
        game.status,
        game.requiredPrefix,
        JSON.stringify(game.startingLetters || []),
        game.currentPlayerId,
        game.lastWord,
        game.invalidAttempts || 0,
        game.turnEndsAt,
        game.createdAt,
        game.startedAt,
        game.endedAt,
      );
    this.savePlayers(game);
    return this.getById(game.id);
  }

  findByRoomCode(roomCode) {
    const row = this.database.prepare("SELECT * FROM games WHERE room_code = ?").get(roomCode);
    return row ? this.hydrate(row) : null;
  }

  getById(gameId) {
    const row = this.database.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
    return row ? this.hydrate(row) : null;
  }

  listTimedGames() {
    return this.database
      .prepare(`
        SELECT * FROM games
        WHERE status IN ('active', 'choosing-start')
          AND turn_ends_at IS NOT NULL
      `)
      .all()
      .map((row) => this.hydrate(row));
  }

  save(game) {
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(`
          UPDATE games
          SET status = ?, required_prefix = ?, starting_letters = ?, current_player_id = ?,
              last_word = ?, invalid_attempts = ?, turn_ends_at = ?, started_at = ?, ended_at = ?
          WHERE id = ?
        `)
        .run(
          game.status,
          game.requiredPrefix,
          JSON.stringify(game.startingLetters || []),
          game.currentPlayerId,
          game.lastWord,
          game.invalidAttempts || 0,
          game.turnEndsAt,
          game.startedAt,
          game.endedAt,
          game.id,
        );
      this.savePlayers(game);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getById(game.id);
  }

  addPlayer(gameId, player) {
    this.database
      .prepare(`
        INSERT INTO game_players
          (game_id, player_id, player_name, score, lives, turn_order, is_eliminated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        gameId,
        player.id,
        player.name,
        player.score || 0,
        player.lives,
        player.turnOrder,
        player.eliminated ? 1 : 0,
      );
    return this.getById(gameId);
  }

  addWord({ gameId, playerId, word, requiredPrefix, createdAt }) {
    this.database
      .prepare(`
        INSERT INTO game_words (game_id, player_id, word, required_prefix, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(gameId, playerId, word, requiredPrefix, createdAt);
  }

  wordHasBeenUsed(gameId, word) {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM game_words WHERE game_id = ? AND word = ? LIMIT 1")
        .get(gameId, word),
    );
  }

  savePlayers(game) {
    const statement = this.database.prepare(`
      INSERT INTO game_players
        (game_id, player_id, player_name, score, lives, turn_order, is_eliminated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, player_id) DO UPDATE SET
        player_name = excluded.player_name,
        score = excluded.score,
        lives = excluded.lives,
        turn_order = excluded.turn_order,
        is_eliminated = excluded.is_eliminated
    `);
    for (const player of game.players || []) {
      statement.run(
        game.id,
        player.id,
        player.name,
        player.score || 0,
        player.lives,
        player.turnOrder,
        player.eliminated ? 1 : 0,
      );
    }
  }

  hydrate(row) {
    const players = this.database
      .prepare("SELECT * FROM game_players WHERE game_id = ? ORDER BY turn_order ASC")
      .all(row.id)
      .map((player) => ({
        id: player.player_id,
        name: player.player_name,
        score: player.score,
        lives: player.lives,
        turnOrder: player.turn_order,
        eliminated: Boolean(player.is_eliminated),
      }));
    const words = this.database
      .prepare("SELECT * FROM game_words WHERE game_id = ? ORDER BY id ASC")
      .all(row.id)
      .map((word) => ({
        id: word.id,
        playerId: word.player_id,
        word: word.word,
        requiredPrefix: word.required_prefix,
        createdAt: word.created_at,
      }));

    return {
      id: row.id,
      roomCode: row.room_code,
      mode: row.mode,
      status: row.status,
      requiredPrefix: row.required_prefix,
      startingLetters: parseStartingLetters(row.starting_letters),
      currentPlayerId: row.current_player_id,
      lastWord: row.last_word,
      invalidAttempts: row.invalid_attempts,
      turnEndsAt: row.turn_ends_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      players,
      words,
    };
  }
}

module.exports = { SqliteGameRepository };
