const crypto = require("crypto");

class PrefixService {
  constructor({ wordRepository }) {
    this.wordRepository = wordRepository;
  }

  chooseNextPrefix({ gameId, word }) {
    const oneLetterPrefix = word.slice(-1);
    const twoLetterPrefix = word.slice(-2);
    const oneLetterPlayable = this.wordRepository.hasUnusedWordForPrefix({
      gameId,
      prefix: oneLetterPrefix,
    });
    const twoLetterPlayable = this.wordRepository.hasUnusedWordForPrefix({
      gameId,
      prefix: twoLetterPrefix,
    });

    if (oneLetterPlayable && twoLetterPlayable) {
      // Use Node's cryptographically secure random source: each prefix has an
      // exactly equal chance and no client can influence the result.
      return crypto.randomInt(2) === 0 ? oneLetterPrefix : twoLetterPrefix;
    }
    if (oneLetterPlayable) return oneLetterPrefix;
    if (twoLetterPlayable) return twoLetterPrefix;
    return null;
  }
}

module.exports = { PrefixService };
