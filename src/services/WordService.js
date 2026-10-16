class WordService {
  constructor({ wordRepository, gameRepository, config }) {
    this.wordRepository = wordRepository;
    this.gameRepository = gameRepository;
    this.config = config;
  }

  normalize(submittedWord) {
    return String(submittedWord || "").trim().toLowerCase();
  }

  validateFormat(word) {
    if (!/^[a-z]+$/.test(word)) {
      return "Use letters only; punctuation, numbers, and spaces are not allowed.";
    }
    if (word.length < this.config.minWordLength) {
      return `Words must contain at least ${this.config.minWordLength} letters.`;
    }
    return null;
  }

  validateForTurn({ game, word }) {
    const formatError = this.validateFormat(word);
    if (formatError) return formatError;

    if (!word.startsWith(game.requiredPrefix || "")) {
      return `Your word must start with “${String(game.requiredPrefix || "").toUpperCase()}”.`;
    }

    if (!this.wordRepository.wordExists(word)) {
      return "That word does not exist in the game dictionary.";
    }

    if (this.gameRepository.wordHasBeenUsed(game.id, word)) {
      return "This word has already been used.";
    }

    return null;
  }
}

module.exports = { WordService };
