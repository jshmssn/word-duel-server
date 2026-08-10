CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  length INTEGER NOT NULL,
  first_letter TEXT NOT NULL,
  first_two_letters TEXT,
  last_letter TEXT NOT NULL,
  last_two_letters TEXT
);

CREATE INDEX IF NOT EXISTS idx_words_word ON words(word);
CREATE INDEX IF NOT EXISTS idx_words_first_letter ON words(first_letter);
CREATE INDEX IF NOT EXISTS idx_words_first_two_letters ON words(first_two_letters);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  required_prefix TEXT,
  starting_letters TEXT NOT NULL DEFAULT '[]',
  current_player_id TEXT,
  last_word TEXT,
  invalid_attempts INTEGER NOT NULL DEFAULT 0,
  turn_ends_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_room_code ON games(room_code);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  lives INTEGER NOT NULL,
  turn_order INTEGER NOT NULL,
  is_eliminated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_players_game_order
ON game_players(game_id, turn_order);

CREATE TABLE IF NOT EXISTS game_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  word TEXT NOT NULL,
  required_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, word),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_game_words_game_word ON game_words(game_id, word);
CREATE INDEX IF NOT EXISTS idx_game_words_game_created ON game_words(game_id, created_at);
