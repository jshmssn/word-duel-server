const express = require("express");
const { GameServiceError } = require("../services/GameService");

function createGameRouter({ gameService, onGameChanged, sessionRegistry }) {
  const router = express.Router();

  router.post("/validate-word", (request, response) => {
    try {
      const { gameId, playerId, word } = request.body || {};
      const authorization = request.get("authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!sessionRegistry.authorizes({ token, gameId, playerId })) {
        throw new GameServiceError("A valid game session is required.", 401);
      }
      const result = gameService.submitWord({
        gameId,
        playerId,
        submittedWord: word,
      });
      onGameChanged(result.state);
      response.status(result.success ? 200 : 400).json(result);
    } catch (error) {
      const statusCode = error instanceof GameServiceError ? error.statusCode : 500;
      response.status(statusCode).json({ success: false, message: error.message || "Unable to validate word." });
    }
  });

  return router;
}

module.exports = { createGameRouter };
