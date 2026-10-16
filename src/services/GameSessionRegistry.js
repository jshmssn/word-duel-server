const crypto = require("crypto");

class GameSessionRegistry {
  constructor() {
    this.sessions = new Map();
  }

  issue({ gameId, playerIds }) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      gameId,
      playerIds: new Set(playerIds),
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
    return token;
  }

  authorizes({ token, gameId, playerId }) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return session.gameId === gameId && session.playerIds.has(playerId);
  }
}

module.exports = { GameSessionRegistry };
