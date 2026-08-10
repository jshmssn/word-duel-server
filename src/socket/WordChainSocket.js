const { GameServiceError } = require("../services/GameService");

function roomName(gameId) {
  return `word-chain:${gameId}`;
}

class TurnTimerManager {
  constructor({ gameService, io }) {
    this.gameService = gameService;
    this.io = io;
    this.timers = new Map();
  }

  sync(state) {
    this.clear(state.gameId);
    if (
      (state.status !== "active" && state.status !== "choosing-start") ||
      !state.turnEndsAt
    ) {
      return;
    }

    const delay = Math.max(0, new Date(state.turnEndsAt).getTime() - Date.now()) + 30;
    const timer = setTimeout(() => this.handleExpiry(state.gameId), delay);
    this.timers.set(state.gameId, timer);
  }

  clear(gameId) {
    const timer = this.timers.get(gameId);
    if (timer) clearTimeout(timer);
    this.timers.delete(gameId);
  }

  async handleExpiry(gameId) {
    this.timers.delete(gameId);
    try {
      const result = this.gameService.expireTurn(gameId);
      if (!result.success && !result.turnFailed) return;
      broadcastGameState({ io: this.io, state: result.state });
      this.sync(result.state);
    } catch (error) {
      console.error("[Word Chain] Timer error", error);
    }
  }
}

function broadcastGameState({ io, state }) {
  io.to(roomName(state.gameId)).emit("word-chain-state", state);
}

function registerWordChainSocket({ io, gameService, timerManager, sessionRegistry }) {
  io.on("connection", (socket) => {
    socket.on("create-word-chain-game", ({ username, playerTwoName, mode }, reply = () => {}) => {
      try {
        const state = gameService.createGame({
          playerId: socket.id,
          playerName: username,
          playerTwoName,
          mode,
        });
        socket.join(roomName(state.gameId));
        socket.data.wordChainGames = socket.data.wordChainGames || new Set();
        socket.data.wordChainGames.add(state.gameId);
        if (state.mode === "local") socket.data.wordChainLocalGames = socket.data.wordChainLocalGames || new Set();
        if (state.mode === "local") socket.data.wordChainLocalGames.add(state.gameId);
        broadcastGameState({ io, state });
        timerManager.sync(state);
        reply({
          success: true,
          state,
          sessionToken: sessionRegistry.issue({
            gameId: state.gameId,
            playerIds: state.mode === "local" ? state.players.map((player) => player.id) : [socket.id],
          }),
        });
      } catch (error) {
        reply({ success: false, message: error.message });
      }
    });

    socket.on("join-word-chain-game", ({ roomCode, username }, reply = () => {}) => {
      try {
        const state = gameService.joinGame({
          roomCode,
          playerId: socket.id,
          playerName: username,
        });
        socket.join(roomName(state.gameId));
        socket.data.wordChainGames = socket.data.wordChainGames || new Set();
        socket.data.wordChainGames.add(state.gameId);
        broadcastGameState({ io, state });
        timerManager.sync(state);
        reply({
          success: true,
          state,
          sessionToken: sessionRegistry.issue({ gameId: state.gameId, playerIds: [socket.id] }),
        });
      } catch (error) {
        reply({ success: false, message: error.message });
      }
    });

    socket.on("get-word-chain-state", ({ gameId }, reply = () => {}) => {
      try {
        const state = gameService.getState(gameId);
        if (!isAllowedToView(socket, state)) throw new GameServiceError("You are not in this game.", 403);
        reply({ success: true, state });
      } catch (error) {
        reply({ success: false, message: error.message });
      }
    });

    socket.on("select-word-chain-letter", ({ gameId, letter }, reply = () => {}) => {
      runPlayerAction({
        socket,
        gameId,
        reply,
        gameService,
        timerManager,
        io,
        action: (playerId) => gameService.selectStartingLetter({ gameId, playerId, letter }),
      });
    });

    socket.on("submit-word-chain-word", ({ gameId, word }, reply = () => {}) => {
      runPlayerAction({
        socket,
        gameId,
        reply,
        gameService,
        timerManager,
        io,
        action: (playerId) => gameService.submitWord({
          gameId,
          playerId,
          submittedWord: word,
        }),
      });
    });

    socket.on("give-up-word-chain-turn", ({ gameId }, reply = () => {}) => {
      runPlayerAction({
        socket,
        gameId,
        reply,
        gameService,
        timerManager,
        io,
        action: (playerId) => gameService.giveUp({ gameId, playerId }),
      });
    });
  });
}

function runPlayerAction({ socket, gameId, reply, gameService, timerManager, io, action }) {
  try {
    const state = gameService.getState(gameId);
    const playerId = playerIdForAction(socket, state);
    const actionResult = action(playerId);
    // Selecting the opening letter is a state transition; word submissions also
    // carry a success/message payload. Normalize both action shapes here so the
    // transport layer always broadcasts the authoritative state.
    const result = actionResult.state
      ? actionResult
      : { success: true, state: actionResult };
    broadcastGameState({ io, state: result.state });
    timerManager.sync(result.state);
    reply(result);
  } catch (error) {
    reply({ success: false, message: error.message, statusCode: error.statusCode || 500 });
  }
}

function playerIdForAction(socket, state) {
  if (state.mode === "local" && socket.data.wordChainLocalGames?.has(state.gameId)) {
    return state.currentPlayerId;
  }
  if (state.players.some((player) => player.id === socket.id)) return socket.id;
  throw new GameServiceError("You are not allowed to control this game.", 403);
}

function isAllowedToView(socket, state) {
  return (
    socket.data.wordChainGames?.has(state.gameId) ||
    (state.mode === "local" && socket.data.wordChainLocalGames?.has(state.gameId)) ||
    state.players.some((player) => player.id === socket.id)
  );
}

module.exports = {
  TurnTimerManager,
  broadcastGameState,
  registerWordChainSocket,
};
