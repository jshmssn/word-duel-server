const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { runMigrations } = require("../src/database/migrate");
const { SqliteWordRepository } = require("../src/repositories/SqliteWordRepository");
const { SqliteGameRepository } = require("../src/repositories/SqliteGameRepository");
const { WordService } = require("../src/services/WordService");
const { PrefixService } = require("../src/services/PrefixService");
const { GameService } = require("../src/services/GameService");

function buildGameService() {
  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  const wordRepository = new SqliteWordRepository(database);
  [
    "apple", "ant", "elephant", "lemon", "onion", "night", "tiger",
    "tree", "bear", "grape", "goat", "table", "boat",
  ].forEach((word) => wordRepository.insertWord(word));
  const gameRepository = new SqliteGameRepository(database);
  const config = {
    minWordLength: 3,
    turnDurationSeconds: 10,
    startingLives: 3,
    maxInvalidAttempts: 2,
    startingLetterCount: 4,
    minimumWordsPerStartingLetter: 2,
    scoring: {
      validWord: 10,
      charactersBeforeLengthBonus: 4,
      perExtraCharacter: 1,
      twoLetterPrefixBonus: 5,
    },
  };
  const wordService = new WordService({ wordRepository, gameRepository, config });
  const prefixService = new PrefixService({ wordRepository });
  const gameService = new GameService({
    gameRepository,
    wordRepository,
    wordService,
    prefixService,
    config,
  });
  return { database, gameRepository, wordService, prefixService, gameService };
}

test("Word Chain validates the dictionary, prefix, duplicate rule, and 50/50 continuation", () => {
  const { database, gameRepository, wordService, prefixService, gameService } = buildGameService();
  const state = gameService.createGame({
    playerId: "one",
    playerName: "One",
    playerTwoName: "Two",
    mode: "local",
  });

  assert.equal(state.status, "choosing-start");
  assert.equal(state.startingLetters.length, 4);

  const start = gameService.selectStartingLetter({
    gameId: state.gameId,
    playerId: "one",
    letter: "a",
  });
  assert.equal(start.requiredPrefix, "a");

  const accepted = gameService.submitWord({
    gameId: state.gameId,
    playerId: "one",
    submittedWord: "APPLE",
  });
  assert.equal(accepted.success, true);
  assert.ok(["e", "le"].includes(accepted.nextPrefix));
  assert.equal(accepted.scoreAwarded, 11);

  const storedGame = gameRepository.getById(state.gameId);
  assert.equal(
    wordService.validateForTurn({
      game: { ...storedGame, requiredPrefix: "a" },
      word: "apple",
    }),
    "This word has already been used.",
  );
  assert.equal(
    wordService.validateForTurn({
      game: { ...storedGame, requiredPrefix: "a" },
      word: "applezz",
    }),
    "That word does not exist in the game dictionary.",
  );

  assert.ok(
    ["e", "le"].includes(prefixService.chooseNextPrefix({ gameId: state.gameId, word: "apple" })),
  );

  // "night" has a playable T continuation but no playable HT continuation.
  assert.equal(prefixService.chooseNextPrefix({ gameId: state.gameId, word: "night" }), "t");
  database.close();
});

test("an expired turn costs a server-controlled life and advances the game", () => {
  const { database, gameRepository, gameService } = buildGameService();
  const state = gameService.createGame({
    playerId: "one",
    playerName: "One",
    playerTwoName: "Two",
    mode: "local",
  });
  const game = gameRepository.getById(state.gameId);
  game.turnEndsAt = new Date(Date.now() - 1000).toISOString();
  gameRepository.save(game);

  const result = gameService.expireTurn(state.gameId);
  assert.equal(result.turnFailed, true);
  assert.equal(result.state.players.find((player) => player.id === "one").lives, 2);
  assert.equal(result.state.currentPlayerId, "one:local-2");
  database.close();
});
