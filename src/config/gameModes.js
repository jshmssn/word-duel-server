const { colorDuration: validateColorDuration, colorCardCount: validateColorCardCount } = require("../services/ColorCardGame");

const GAME_MODES = Object.freeze({
  "word-duel": { id: "word-duel", name: "Word Duel" },
  "color-card": { id: "color-card", name: "Color Card" },
  "finish-word": { id: "finish-word", name: "Finish the Word" },
});

function roomOptions({ gameMode = "word-duel", maxPlayers = 2, colorDuration = 30, colorCardCount = 5 } = {}) {
  if (typeof gameMode !== "string" || !Object.hasOwn(GAME_MODES, gameMode)) throw new Error("Choose a valid game mode.");
  const limit = Number(maxPlayers);
  if (!Number.isInteger(limit) || limit < 2 || limit > 8) {
    throw new Error("Max players must be a whole number from 2 to 8.");
  }
  return { gameMode, maxPlayers: limit, ...(gameMode === "color-card" ? {
    colorDuration: validateColorDuration(colorDuration), colorCardCount: validateColorCardCount(colorCardCount),
  } : {}) };
}

module.exports = { GAME_MODES, roomOptions };

