const crypto = require("crypto");

class GameServiceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "GameServiceError";
    this.statusCode = statusCode;
  }
}

function shuffled(items) {
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

class GameService {
  constructor({ gameRepository, wordRepository, wordService, prefixService, config }) {
    this.gameRepository = gameRepository;
    this.wordRepository = wordRepository;
    this.wordService = wordService;
    this.prefixService = prefixService;
    this.config = config;
  }

  createGame({ playerId, playerName, playerTwoName, mode = "online" }) {
    const safeName = String(playerName || "").trim().slice(0, 24);
    if (!safeName) throw new GameServiceError("Enter a player name first.");
    if (mode !== "online" && mode !== "local") {
      throw new GameServiceError("Unknown game mode.");
    }

    const now = new Date().toISOString();
    const game = {
      id: crypto.randomUUID(),
      roomCode: this.createRoomCode(),
      mode,
      status: mode === "local" ? "choosing-start" : "waiting",
      requiredPrefix: null,
      startingLetters: [],
      currentPlayerId: playerId,
      lastWord: null,
      invalidAttempts: 0,
      turnEndsAt: null,
      createdAt: now,
      startedAt: mode === "local" ? now : null,
      endedAt: null,
      players: [],
    };

    this.gameRepository.create(game);
    this.gameRepository.addPlayer(game.id, this.createPlayer(playerId, safeName, 0));

    if (mode === "local") {
      this.gameRepository.addPlayer(
        game.id,
        this.createPlayer(
          `${playerId}:local-2`,
          String(playerTwoName || "Player 2").trim().slice(0, 24) || "Player 2",
          1,
        ),
      );
      const localGame = this.gameRepository.getById(game.id);
      this.prepareStartingTurn(localGame);
      return this.publicState(this.gameRepository.save(localGame));
    }

    return this.publicState(this.gameRepository.getById(game.id));
  }

  joinGame({ roomCode, playerId, playerName }) {
    const game = this.gameRepository.findByRoomCode(String(roomCode || "").trim().toUpperCase());
    if (!game) throw new GameServiceError("Room not found.", 404);
    if (game.mode !== "online") throw new GameServiceError("This is not an online room.");
    if (game.status !== "waiting") throw new GameServiceError("That game has already started.");
    if (game.players.length >= 2) throw new GameServiceError("Room is full.");

    const safeName = String(playerName || "").trim().slice(0, 24);
    if (!safeName) throw new GameServiceError("Enter a player name first.");
    this.gameRepository.addPlayer(game.id, this.createPlayer(playerId, safeName, game.players.length));
    const joinedGame = this.gameRepository.getById(game.id);
    this.prepareStartingTurn(joinedGame);
    return this.publicState(this.gameRepository.save(joinedGame));
  }

  getState(gameId) {
    const game = this.requireGame(gameId);
    return this.publicState(game);
  }

  selectStartingLetter({ gameId, playerId, letter }) {
    const game = this.requireGame(gameId);
    this.requireCurrentPlayer(game, playerId);
    if (game.status !== "choosing-start") {
      throw new GameServiceError("The starting letter has already been chosen.");
    }

    const normalizedLetter = String(letter || "").trim().toLowerCase();
    if (!game.startingLetters.includes(normalizedLetter)) {
      throw new GameServiceError("Choose one of the letters shown by the server.");
    }

    game.status = "active";
    game.requiredPrefix = normalizedLetter;
    game.invalidAttempts = 0;
    this.startTurnClock(game);
    return this.publicState(this.gameRepository.save(game));
  }

  submitWord({ gameId, playerId, submittedWord }) {
    let game = this.requireGame(gameId);
    this.requireCurrentPlayer(game, playerId);
    if (game.status !== "active") throw new GameServiceError("The game is not accepting words right now.");

    if (this.isTurnExpired(game)) {
      return this.expireTurn(gameId);
    }

    const word = this.wordService.normalize(submittedWord);
    const validationError = this.wordService.validateForTurn({ game, word });
    if (validationError) return this.recordInvalidAttempt(game, validationError);

    const currentPlayer = this.getPlayer(game, playerId);
    const scoreAwarded = this.calculateScore(word, game.requiredPrefix);
    this.gameRepository.addWord({
      gameId: game.id,
      playerId,
      word,
      requiredPrefix: game.requiredPrefix,
      createdAt: new Date().toISOString(),
    });
    currentPlayer.score += scoreAwarded;
    game.lastWord = word;
    game.invalidAttempts = 0;

    const nextPrefix = this.prefixService.chooseNextPrefix({ gameId: game.id, word });
    if (!nextPrefix) {
      game.status = "ended";
      game.requiredPrefix = null;
      game.currentPlayerId = null;
      game.turnEndsAt = null;
      game.endedAt = new Date().toISOString();
      const saved = this.gameRepository.save(game);
      return {
        success: true,
        message: "No unused dictionary word can continue the chain. Round complete!",
        scoreAwarded,
        nextPrefix: null,
        state: this.publicState(saved),
      };
    }

    game.requiredPrefix = nextPrefix;
    game.currentPlayerId = this.nextActivePlayerId(game, playerId);
    this.startTurnClock(game);
    const saved = this.gameRepository.save(game);
    return {
      success: true,
      message: `Accepted: ${word.toUpperCase()}`,
      word,
      scoreAwarded,
      nextPrefix,
      nextPlayerId: saved.currentPlayerId,
      state: this.publicState(saved),
    };
  }

  giveUp({ gameId, playerId }) {
    const game = this.requireGame(gameId);
    this.requireCurrentPlayer(game, playerId);
    if (game.status !== "active" && game.status !== "choosing-start") {
      throw new GameServiceError("There is no active turn to give up.");
    }
    return this.failCurrentTurn(game, "You gave up this turn.");
  }

  expireTurn(gameId) {
    const game = this.requireGame(gameId);
    if ((game.status !== "active" && game.status !== "choosing-start") || !this.isTurnExpired(game)) {
      return { success: false, state: this.publicState(game) };
    }
    return this.failCurrentTurn(game, "Time expired. You lost a life.");
  }

  recordInvalidAttempt(game, message) {
    game.invalidAttempts += 1;
    if (game.invalidAttempts >= this.config.maxInvalidAttempts) {
      return this.failCurrentTurn(
        game,
        `${message} Too many invalid attempts — you lost a life.`,
      );
    }

    const saved = this.gameRepository.save(game);
    return {
      success: false,
      message,
      attemptsRemaining: this.config.maxInvalidAttempts - saved.invalidAttempts,
      state: this.publicState(saved),
    };
  }

  failCurrentTurn(game, message) {
    const failedPlayer = this.getPlayer(game, game.currentPlayerId);
    failedPlayer.lives = Math.max(0, failedPlayer.lives - 1);
    failedPlayer.eliminated = failedPlayer.lives === 0;
    game.invalidAttempts = 0;

    const activePlayers = game.players.filter((player) => !player.eliminated);
    if (activePlayers.length <= 1) {
      game.status = "ended";
      game.currentPlayerId = null;
      game.requiredPrefix = null;
      game.turnEndsAt = null;
      game.endedAt = new Date().toISOString();
    } else {
      game.currentPlayerId = this.nextActivePlayerId(game, failedPlayer.id);
      this.startTurnClock(game);
    }

    const saved = this.gameRepository.save(game);
    return {
      success: false,
      turnFailed: true,
      message,
      state: this.publicState(saved),
    };
  }

  prepareStartingTurn(game) {
    const candidates = this.wordRepository.getStartingLetters({
      gameId: game.id,
      minimumAvailableWords: this.config.minimumWordsPerStartingLetter,
    });
    if (candidates.length < this.config.startingLetterCount) {
      throw new GameServiceError(
        "The local SCOWL dictionary is not ready. Run npm run import-words in the server directory.",
        503,
      );
    }

    game.status = "choosing-start";
    game.currentPlayerId = game.players[0].id;
    game.startingLetters = shuffled(candidates).slice(0, this.config.startingLetterCount);
    game.requiredPrefix = null;
    game.invalidAttempts = 0;
    game.startedAt = game.startedAt || new Date().toISOString();
    this.startTurnClock(game);
  }

  publicState(game) {
    return {
      gameId: game.id,
      roomCode: game.roomCode,
      mode: game.mode,
      status: game.status,
      requiredPrefix: game.requiredPrefix,
      startingLetters: game.startingLetters,
      currentPlayerId: game.currentPlayerId,
      lastWord: game.lastWord,
      invalidAttempts: game.invalidAttempts,
      maxInvalidAttempts: this.config.maxInvalidAttempts,
      turnEndsAt: game.turnEndsAt,
      turnDurationSeconds: this.config.turnDurationSeconds,
      players: game.players.map((player) => ({ ...player })),
      words: game.words.map((word) => ({ ...word })),
      isComplete: game.status === "ended",
    };
  }

  createRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempts = 0; attempts < 20; attempts += 1) {
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        code += alphabet[crypto.randomInt(alphabet.length)];
      }
      if (!this.gameRepository.findByRoomCode(code)) return code;
    }
    throw new GameServiceError("Unable to create a room. Please try again.", 503);
  }

  createPlayer(id, name, turnOrder) {
    return {
      id,
      name,
      score: 0,
      lives: this.config.startingLives,
      turnOrder,
      eliminated: false,
    };
  }

  requireGame(gameId) {
    const game = this.gameRepository.getById(gameId);
    if (!game) throw new GameServiceError("Game not found.", 404);
    return game;
  }

  requireCurrentPlayer(game, playerId) {
    if (!game.players.some((player) => player.id === playerId)) {
      throw new GameServiceError("You are not a player in this game.", 403);
    }
    if (game.currentPlayerId !== playerId) {
      throw new GameServiceError("It is not your turn.", 409);
    }
  }

  getPlayer(game, playerId) {
    const player = game.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new GameServiceError("Player not found.", 404);
    return player;
  }

  nextActivePlayerId(game, playerId) {
    const sortedPlayers = [...game.players].sort((first, second) => first.turnOrder - second.turnOrder);
    const startingIndex = sortedPlayers.findIndex((player) => player.id === playerId);
    for (let offset = 1; offset <= sortedPlayers.length; offset += 1) {
      const candidate = sortedPlayers[(startingIndex + offset) % sortedPlayers.length];
      if (!candidate.eliminated) return candidate.id;
    }
    return null;
  }

  calculateScore(word, requiredPrefix) {
    const scoring = this.config.scoring;
    const lengthBonus = Math.max(0, word.length - scoring.charactersBeforeLengthBonus) * scoring.perExtraCharacter;
    const prefixBonus = requiredPrefix.length === 2 ? scoring.twoLetterPrefixBonus : 0;
    return scoring.validWord + lengthBonus + prefixBonus;
  }

  startTurnClock(game) {
    game.turnEndsAt = new Date(Date.now() + this.config.turnDurationSeconds * 1000).toISOString();
  }

  isTurnExpired(game) {
    return Boolean(game.turnEndsAt && new Date(game.turnEndsAt).getTime() <= Date.now());
  }
}

module.exports = { GameService, GameServiceError };
