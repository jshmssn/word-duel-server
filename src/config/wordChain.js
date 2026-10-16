const WORD_CHAIN_CONFIG = Object.freeze({
  minWordLength: Number(process.env.WORD_CHAIN_MIN_LENGTH) || 3,
  turnDurationSeconds: Number(process.env.WORD_CHAIN_TURN_SECONDS) || 10,
  startingLives: Number(process.env.WORD_CHAIN_STARTING_LIVES) || 3,
  maxInvalidAttempts: Number(process.env.WORD_CHAIN_MAX_INVALID_ATTEMPTS) || 2,
  startingLetterCount: 4,
  minimumWordsPerStartingLetter:
    Number(process.env.WORD_CHAIN_MIN_STARTING_OPTIONS) || 25,
  scoring: Object.freeze({
    validWord: 10,
    charactersBeforeLengthBonus: 4,
    perExtraCharacter: 1,
    twoLetterPrefixBonus: 5,
  }),
});

module.exports = { WORD_CHAIN_CONFIG };
