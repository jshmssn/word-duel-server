function lobbyPlayerId(socket) { return socket.data?.playerId || socket.id; }
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { randomUUID } = require("node:crypto");
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 90_000;
const wordsData = require("./words.json");
const { roomOptions } = require("./src/config/gameModes");
const { ColorCardRounds } = require("./src/socket/ColorCardSocket");
const { createDatabase } = require("./src/database/connection");
const { runMigrations } = require("./src/database/migrate");
const { WORD_CHAIN_CONFIG } = require("./src/config/wordChain");
const { SqliteWordRepository } = require("./src/repositories/SqliteWordRepository");
const { SqliteGameRepository } = require("./src/repositories/SqliteGameRepository");
const { WordService } = require("./src/services/WordService");
const { PrefixService } = require("./src/services/PrefixService");
const { GameService } = require("./src/services/GameService");
const { GameSessionRegistry } = require("./src/services/GameSessionRegistry");
const { createGameRouter } = require("./src/routes/gameRoutes");
const {
  TurnTimerManager,
  broadcastGameState,
  registerWordChainSocket,
} = require("./src/socket/WordChainSocket");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Word Chain keeps persistence and rules outside the legacy duel handlers so the
// SQLite adapter can be replaced by a MySQL repository without changing sockets,
// routes, or game logic.
const wordChainDatabase = createDatabase();
runMigrations(wordChainDatabase);
const wordChainRepository = new SqliteWordRepository(wordChainDatabase);
const wordChainGameRepository = new SqliteGameRepository(wordChainDatabase);
const wordChainService = new WordService({
  wordRepository: wordChainRepository,
  gameRepository: wordChainGameRepository,
  config: WORD_CHAIN_CONFIG,
});
const wordChainGameService = new GameService({
  gameRepository: wordChainGameRepository,
  wordRepository: wordChainRepository,
  wordService: wordChainService,
  prefixService: new PrefixService({ wordRepository: wordChainRepository }),
  config: WORD_CHAIN_CONFIG,
});
const wordChainTimerManager = new TurnTimerManager({
  gameService: wordChainGameService,
  io,
});
const wordChainSessionRegistry = new GameSessionRegistry();
// Restore server-side countdown enforcement for any game that was active when
// this process last stopped. Expired turns resolve on the first scheduled tick.
wordChainGameRepository.listTimedGames().forEach((game) => {
  wordChainTimerManager.sync(wordChainGameService.publicState(game));
});

app.use(
  "/api/game",
  createGameRouter({
    gameService: wordChainGameService,
    sessionRegistry: wordChainSessionRegistry,
    onGameChanged: (state) => {
      broadcastGameState({ io, state });
      wordChainTimerManager.sync(state);
    },
  }),
);
registerWordChainSocket({
  io,
  gameService: wordChainGameService,
  timerManager: wordChainTimerManager,
  sessionRegistry: wordChainSessionRegistry,
});

const rooms = Object.create(null);
const colorCardRounds = new ColorCardRounds({ io, rooms, publicPlayers });
const gameModeHandlers = {
  "word-duel": { start: beginSlotMachine },
  "color-card": { start: (code) => colorCardRounds.start(rooms[code]) },
};

function lobbyState(room) {
  return {
    code: room.code, creatorId: room.creatorId, players: publicPlayers(room),
    mode: room.mode, gameMode: room.gameMode, maxPlayers: room.maxPlayers,
    turnDuration: room.turnDuration, roundLimit: room.roundLimit,
    colorDuration: room.colorDuration,
    colorCardCount: room.colorCardCount,
    pausedAt: room.pausedAt || null,
  };
}

function playerName(username) {
  const name = typeof username === "string" ? username.trim().slice(0, 24) : "";
  if (!name) throw new Error("Enter your name first.");
  return name;
}

function beginRound(code) {
  const room = rooms[code];
  if (!room || room.state !== "waiting" || !roomReadyToStart(room)) return;
  gameModeHandlers[room.gameMode].start(code);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffleItems(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getCategoryByName(name) {
  return wordsData.categories.find((category) => category.name === name) || null;
}

function refillCategoryBag(room) {
  const names = shuffleItems(wordsData.categories.map((category) => category.name));

  if (room?.category && names.length > 1 && names[0] === room.category) {
    const swapIndex = names.findIndex((name) => name !== room.category);
    [names[0], names[swapIndex]] = [names[swapIndex], names[0]];
  }

  room.categoryBag = names;
}

function pickCategory(room = null) {
  if (!wordsData.categories.length) return null;
  if (!room) {
    return wordsData.categories[Math.floor(Math.random() * wordsData.categories.length)];
  }

  if (!Array.isArray(room.categoryBag) || room.categoryBag.length === 0) {
    refillCategoryBag(room);
  }

  let category = null;
  while (room.categoryBag.length > 0 && !category) {
    category = getCategoryByName(room.categoryBag.shift());
  }

  if (!category) {
    refillCategoryBag(room);
    category = getCategoryByName(room.categoryBag.shift());
  }

  return category || wordsData.categories[Math.floor(Math.random() * wordsData.categories.length)];
}

function getEligibleWords(category) {
  return category.words.filter((w) => {
    const letters = w.replace(/[^a-zA-Z]/g, "");
    return letters.length >= 5 && letters.length <= 10;
  });
}

function pickWord(category) {
  const eligible = getEligibleWords(category);
  if (!eligible.length) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

function pickWordPair(category) {
  const eligible = getEligibleWords(category);
  const byLength = eligible.reduce((groups, word) => {
    const length = getLetterCount(word);
    if (!groups[length]) groups[length] = [];
    groups[length].push(word);
    return groups;
  }, {});
  const pairableGroups = Object.values(byLength).filter((group) => group.length >= 2);

  if (!pairableGroups.length) {
    const fallback = pickWord(category) || "";
    return [fallback, fallback];
  }

  const group = pairableGroups[Math.floor(Math.random() * pairableGroups.length)];
  const word1 = group[Math.floor(Math.random() * group.length)];
  let word2 = group[Math.floor(Math.random() * group.length)];
  let attempts = 0;

  while (normalizeWord(word2) === normalizeWord(word1) && attempts < 30) {
    word2 = group[Math.floor(Math.random() * group.length)];
    attempts++;
  }

  return [word1, word2];
}

function getLetterCount(word) {
  return String(word || "").replace(/[^a-zA-Z]/g, "").length;
}

function normalizeWord(word) {
  return String(word || "").toLowerCase().replace(/[^a-z]/g, "");
}

function sanitizeTurnDuration(turnDuration) {
  const duration = Number(turnDuration) || 0;
  return [0, 30, 45, 60].includes(duration) ? duration : 0;
}

function sanitizeRoundLimit(roundLimit) {
  const limit = Number(roundLimit) || 1;
  return [1, 3, 5].includes(limit) ? limit : 1;
}

function getWinsToSeries(roundLimit) {
  return Math.floor(sanitizeRoundLimit(roundLimit) / 2) + 1;
}

function getBotId(code) {
  return `bot:${code}`;
}

function isBotPlayer(player) {
  return Boolean(player && player.isBot);
}

function getHumanPlayers(room) {
  return room.players.filter((p) => !isBotPlayer(p));
}

function getConfirmedLetterCounts(room, playerId) {
  const existing = room.confirmedLetters[playerId];
  if (!existing) {
    room.confirmedLetters[playerId] = {};
    return room.confirmedLetters[playerId];
  }

  if (existing instanceof Set) {
    const counts = {};
    existing.forEach((letter) => {
      counts[letter] = Math.max(counts[letter] || 0, 1);
    });
    room.confirmedLetters[playerId] = counts;
    return counts;
  }

  if (Array.isArray(existing)) {
    const counts = {};
    existing.forEach((letter) => {
      counts[letter] = (counts[letter] || 0) + 1;
    });
    room.confirmedLetters[playerId] = counts;
    return counts;
  }

  return existing;
}

function setConfirmedLetterCount(room, playerId, letter, count) {
  const counts = getConfirmedLetterCounts(room, playerId);
  const normalizedCount = Math.max(0, parseInt(count, 10) || 0);

  if (normalizedCount === 0) delete counts[letter];
  else counts[letter] = normalizedCount;
}

function getExpandedConfirmedLetters(room, playerId) {
  const counts = getConfirmedLetterCounts(room, playerId);
  return Object.entries(counts).flatMap(([letter, count]) =>
    Array.from({ length: count }, () => letter),
  );
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    username: p.username,
    ready: p.ready,
    wins: p.wins || 0,
    isBot: Boolean(p.isBot),
    connected: p.connected !== false,
    ...(room.gameMode === "color-card" && room.state === "waiting" ? {
      previousMatchAverageAccuracy: p.previousMatchAverageAccuracy || 0,
      previousMatchCardCount: p.previousMatchCardCount || 0,
      previousMatchId: p.previousMatchId || null,
    } : {}),
  }));
}

function broadcastReadyState(code, changedPlayerId) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("ready-update", {
    ...lobbyState(room),
    ...(changedPlayerId ? { changedPlayerId } : {}),
  });
}

function roomReadyToStart(room) {
  return !room.pausedAt && room.players.length >= 2 && room.players.length <= room.maxPlayers && room.players.every((p) => p.ready && p.connected !== false);
}

// ─── Countdown logic ─────────────────────────────────────────────────────────

function startCountdown(code) {
  const room = rooms[code];
  if (!room) return;
  clearCountdown(code);
  room.countdownDelay = setTimeout(() => {
    const activeRoom = rooms[code];
    if (!activeRoom) return;
    activeRoom.countdownDelay = null;
    if (!roomReadyToStart(activeRoom)) return;

    let count = 5;
    io.to(code).emit("countdown", { count });
    activeRoom.countdownInterval = setInterval(() => {
      const currentRoom = rooms[code];
      if (!currentRoom) { clearInterval(activeRoom.countdownInterval); return; }
      if (!roomReadyToStart(currentRoom)) { clearCountdown(code); return; }
      count--;
      if (count <= 0) {
        clearInterval(activeRoom.countdownInterval);
        activeRoom.countdownInterval = null;
        beginRound(code);
      } else {
        io.to(code).emit("countdown", { count });
      }
    }, 1000);
  }, 2000);
}

function clearCountdown(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.countdownDelay) { clearTimeout(room.countdownDelay); room.countdownDelay = null; }
  if (room.countdownInterval) { clearInterval(room.countdownInterval); room.countdownInterval = null; }
  io.to(code).emit("countdown-cancel");
}

// ─── Turn Timer ───────────────────────────────────────────────────────────────

function startTurnTimer(code, resumeRemaining) {
  const room = rooms[code];
  if (!room || !room.turnDuration || room.pausedAt) return;
  const currentPlayer = room.players.find((p) => p.id === room.currentTurn);
  if (isBotPlayer(currentPlayer)) return;
  clearTurnTimer(code);

  let remaining = resumeRemaining ?? room.turnDuration;
  room.turnRemaining = remaining;
  io.to(code).emit("timer-update", { remaining, total: room.turnDuration });

  room.turnTimerInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(room.turnTimerInterval); return; }
    remaining--;
    room.turnRemaining = remaining;
    io.to(code).emit("timer-update", { remaining, total: room.turnDuration });
    if (remaining <= 0) {
      clearTurnTimer(code);
      io.to(code).emit("turn-timeout", { playerId: room.currentTurn });
      passTurn(code, true);
    }
  }, 1000);
}

function clearTurnTimer(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.turnTimerInterval) {
    clearInterval(room.turnTimerInterval);
    room.turnTimerInterval = null;
  }
}

// ─── Socket Events ───────────────────────────────────────────────────────────

function clearBotTimer(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.botActionTimer) {
    clearTimeout(room.botActionTimer);
    room.botActionTimer = null;
  }
}

function createRoomState(code, creatorId, username, { withBot = false, gameMode = "word-duel", maxPlayers = 2, colorDuration = 30, colorCardCount = 5 } = {}) {
  const players = [{ id: creatorId, username, ready: false, wins: 0 }];

  if (withBot) {
    players.push({
      id: getBotId(code),
      username: "Word Bot",
      ready: true,
      wins: 0,
      isBot: true,
    });
  }

  return {
    code,
    creatorId,
    players,
    mode: withBot ? "bot" : "duel",
    gameMode,
    maxPlayers,
    colorRound: null,
    colorMatch: null,
    colorRanking: null,
    colorDuration,
    colorCardCount,
    state: "waiting",
    currentTurn: null,
    category: null,
    categoryData: null,
    pendingCategory: null,
    categoryBag: [],
    slotDoneIds: null,
    words: {},
    confirmedLetters: {},
    guessAttempts: {},
    chatHistory: [],
    countdownDelay: null,
    countdownInterval: null,
    turnDuration: 0,
    roundLimit: 1,
    seriesOver: false,
    turnTimerInterval: null,
    botActionTimer: null,
    botAskedLetters: {},
    botCountAskedLetters: {},
    botGuesses: {},
    pendingLetterAsk: null,
    pendingLetterCount: null,
    pausedAt: null,
    askedLetters: {},
  };
}

function attachRoomSession(socket, room, player) {
  socket.data.playerId = player.id;
  socket.data.lobbyCode = room.code;
  socket.join(room.code);
  socket.join(player.id);
  player.socketId = socket.id;
  player.connected = true;
  player.sessionToken ||= randomUUID();
  clearTimeout(player.reconnectTimer);
  player.reconnectTimer = null;
  socket.emit("room-session", { code: room.code, playerId: player.id, token: player.sessionToken });
}

function personalRoomState(room, playerId) {
  let state = {};
  if (room.gameMode === "color-card" && room.colorRound) state = colorCardRounds.snapshot(room, playerId);
  else if (room.state === "playing") {
    const opponent = getOpponent(room, playerId);
    const prompt = (pending) => pending && getOpponent(room, pending.askerId)?.id === playerId
      ? { askerName: room.players.find((player) => player.id === pending.askerId)?.username, letter: pending.letter } : null;
    state.gameState = {
      ...lobbyState(room), category: room.category, opponentId: opponent?.id,
      myWord: room.words[playerId], myWordLetterCount: getLetterCount(room.words[playerId]),
      opponentLetterCount: getLetterCount(room.words[opponent?.id]), currentTurn: room.currentTurn,
      confirmedLetters: getExpandedConfirmedLetters(room, playerId), askedLetters: room.askedLetters?.[playerId] || {},
      timerRemaining: room.turnRemaining ?? room.turnDuration,
      letterAskPrompt: prompt(room.pendingLetterAsk), letterCountPrompt: prompt(room.pendingLetterCount),
      waitingFor: [room.pendingLetterAsk, room.pendingLetterCount].find((pending) => pending?.askerId === playerId) || null,
    };
  } else if (room.state === "ended") state.result = room.lastResult;
  return {
    ...lobbyState(room), ...state, playerId, serverNow: Date.now(),
    screen: state.gameState ? "game" : state.result ? "gameover" : "waiting",
    chatMessages: room.chatHistory,
    pendingCategory: room.state === "slotting" ? room.category : null,
  };
}

function sendRoomSnapshots(room) {
  getHumanPlayers(room).filter((player) => player.connected !== false).forEach((player) => {
    io.to(player.id).emit("room-restored", personalRoomState(room, player.id));
  });
}

function pauseRoom(room, player) {
  if (!room.pausedAt) {
    room.pausedAt = Date.now();
    clearCountdown(room.code);
    clearTurnTimer(room.code);
    clearBotTimer(room.code);
    colorCardRounds.clear(room.code);
  }
  io.to(room.code).emit("ROOM_PAUSED", {
    code: room.code, players: publicPlayers(room), pausedAt: room.pausedAt,
    serverNow: Date.now(), expiresAt: player.reconnectExpiresAt,
    message: `${player.username} is reconnecting. The room and timers are paused.`,
  });
}

function resumeRoom(room) {
  if (!room.pausedAt || room.players.some((player) => player.connected === false)) return;
  const duration = Date.now() - room.pausedAt;
  room.pausedAt = null;
  if (room.gameMode === "color-card" && room.colorRound) colorCardRounds.resume(room, duration);
  else if (room.state === "playing") {
    if (!room.pendingLetterAsk && !room.pendingLetterCount) {
      startTurnTimer(room.code, room.turnRemaining);
      scheduleBotTurnIfNeeded(room.code);
    }
  } else if (room.state === "waiting" && roomReadyToStart(room)) startCountdown(room.code);
  io.to(room.code).emit("ROOM_RESUMED", { code: room.code, players: publicPlayers(room), message: "Everyone is back. The room has resumed!" });
  sendRoomSnapshots(room);
  if (room.state === "slotting") io.to(room.code).emit("category-selected", { category: room.category, selectedCategoryName: room.category });
}

function reserveSeat(room, player, socket, disconnected = false) {
  if (disconnected) colorCardRounds.resetPreviousMatch(room);
  if (player.reconnectTimer) {
    if (disconnected) pauseRoom(room, player);
    return;
  }
  player.connected = false;
  player.reconnectExpiresAt = Date.now() + RECONNECT_GRACE_MS;
  pauseRoom(room, player);
  player.reconnectTimer = setTimeout(() => {
    if (rooms[room.code] === room && player.connected === false) {
      // An app may remain connected while backgrounded; release that seat too.
      leaveRoom(socket, true);
    }
  }, RECONNECT_GRACE_MS);
  player.reconnectTimer.unref();
}

// Explicit quits and expired reconnection reservations release room resources.
function leaveRoom(socket, disconnected = false) {
  const code = socket.data.lobbyCode;
  const room = rooms[code];
  const index = room?.players.findIndex((player) => player.id === lobbyPlayerId(socket)) ?? -1;
  if (index < 0) {
    socket.data.lobbyCode = null;
    return;
  }
  const [left] = room.players.splice(index, 1);
  colorCardRounds.resetPreviousMatch(room);
  clearTimeout(left.reconnectTimer);
  const cancelled = !["waiting", "ended"].includes(room.state);
  socket.leave(code);
  socket.data.lobbyCode = null;
  clearCountdown(code);
  clearTurnTimer(code);
  clearBotTimer(code);
  colorCardRounds.clear(code);
  room.colorRound = null;
  room.colorMatch = null;
  room.colorRanking = null;
  room.pendingLetterAsk = null;
  room.pendingLetterCount = null;
  room.currentTurn = null;
  room.words = {};
  room.confirmedLetters = {};
  room.pendingCategory = null;
  room.slotDoneIds = null;
  if (!room.players.some((player) => player.connected === false)) room.pausedAt = null;

  const text = `${left.username} ${disconnected ? "disconnected" : "quit the room"}.${cancelled ? " The round was cancelled; ready up to play again." : ""}`;
  const message = { id: Date.now() + Math.random(), system: true, text, timestamp: Date.now() };
  room.chatHistory.push(message);
  room.chatHistory = room.chatHistory.slice(-100);
  io.to(code).emit("chat-message", message);
  io.to(code).emit("player-left", { code, playerId: left.id, username: left.username, disconnected, message: text });
  if (!getHumanPlayers(room).length) {
    delete rooms[code];
    return;
  }
  room.state = "waiting";
  if (room.creatorId === left.id) room.creatorId = getHumanPlayers(room)[0].id;
  room.players.forEach((player) => { player.ready = isBotPlayer(player); });
  broadcastReadyState(code);
  io.to(code).emit("rematch-lobby", { ...lobbyState(room), message: text, departure: true });
}

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${lobbyPlayerId(socket)}`);
  colorCardRounds.register(socket);
  socket.use(([event, , reply], next) => {
    const room = rooms[socket.data.lobbyCode];
    if (room?.pausedAt && !["resume-room", "suspend-room", "leave-room", "chat-message"].includes(event)) {
      const response = { success: false, message: "The room is paused while a player reconnects." };
      if (typeof reply === "function") reply(response);
      else socket.emit("room-action-error", response);
      return;
    }
    next();
  });

  socket.on("suspend-room", (payload = {}) => {
    const room = rooms[socket.data.lobbyCode];
    const player = room?.players.find((candidate) => candidate.id === lobbyPlayerId(socket));
    if (room && player && payload.code === room.code) reserveSeat(room, player, socket);
  });

  socket.on("resume-room", (payload = {}, reply) => {
    try {
      const room = rooms[payload?.code];
      const player = room?.players.find((candidate) => candidate.sessionToken && candidate.sessionToken === payload?.token);
      if (!player || (player.connected === false && Date.now() >= player.reconnectExpiresAt)) throw new Error("Your room reservation expired. Join a room to play again.");
      if (socket.data.lobbyCode && socket.data.lobbyCode !== room.code) throw new Error("You are already in another room.");
      const previousSocket = io.sockets.sockets.get(player.socketId);
      attachRoomSession(socket, room, player);
      if (previousSocket && previousSocket !== socket) previousSocket.disconnect(true);
      if (room.pausedAt && !room.players.some((candidate) => candidate.connected === false)) resumeRoom(room);
      else socket.emit("room-restored", personalRoomState(room, player.id));
      if (typeof reply === "function") reply({ success: true });
    } catch (error) { if (typeof reply === "function") reply({ success: false, message: error.message }); }
  });

  // ── Create Room ──
  const createRoom = (payload = {}, reply) => {
    try {
      if (socket.data.lobbyCode) throw new Error("You are already in a room.");
      const { username, ...options } = payload || {};
      const name = playerName(username);
      const settings = roomOptions(options);
      let code;
      do { code = generateRoomCode(); } while (rooms[code]);

      rooms[code] = createRoomState(code, lobbyPlayerId(socket), name, settings);

      attachRoomSession(socket, rooms[code], rooms[code].players[0]);
      const state = lobbyState(rooms[code]);
      socket.emit("room-created", state);
      if (typeof reply === "function") reply({ success: true, ...state });
      console.log(`[Room] ${code} created by ${name}`);
    } catch (error) {
      socket.emit("join-error", { message: error.message });
      if (typeof reply === "function") reply({ success: false, message: error.message });
    }
  };
  socket.on("CREATE_ROOM", createRoom);
  socket.on("create-room", createRoom);

  socket.on("create-bot-room", (payload = {}) => {
    let username;
    try {
      if (socket.data.lobbyCode) throw new Error("You are already in a room.");
      username = playerName(payload?.username);
    } catch (error) { socket.emit("join-error", { message: error.message }); return; }
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = createRoomState(code, lobbyPlayerId(socket), username, { withBot: true });

    attachRoomSession(socket, rooms[code], rooms[code].players[0]);
    socket.emit("room-created", lobbyState(rooms[code]));
    console.log(`[Bot Room] ${code} created by ${username}`);
  });

  // ── Join Room ──
  const joinRoom = (payload = {}) => {
    let code, username;
    try {
      if (socket.data.lobbyCode) throw new Error("You are already in a room.");
      code = String(payload?.code || "").trim().toUpperCase();
      username = playerName(payload?.username);
    } catch (error) { socket.emit("join-error", { message: error.message }); return; }
    const room = rooms[code];
    if (!room) { socket.emit("join-error", { message: "Room not found." }); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit("join-error", { message: "Room is full." }); return; }
    if (room.state !== "waiting") { socket.emit("join-error", { message: "Game already in progress." }); return; }

    room.players.push({ id: lobbyPlayerId(socket), username, ready: false, wins: 0 });
    attachRoomSession(socket, room, room.players.at(-1));
    clearCountdown(code);

    socket.emit("chat-history", { messages: room.chatHistory });

    const joinedState = lobbyState(room);
    io.to(code).emit("player-joined", { ...joinedState, joinedPlayerId: lobbyPlayerId(socket) });
    // Explicit acknowledgement prevents the joining client from showing a room
    // that rejected its code (e.g. a full room or a game already in progress).
    socket.emit("room-joined", joinedState);

    console.log(`[Room] ${username} joined ${code}`);
  };
  socket.on("JOIN_ROOM", joinRoom);
  socket.on("join-room", joinRoom);

  socket.on("START_GAME", (payload, reply) => {
    const { code } = payload || {};
    const room = rooms[code];
    if (!room || room.creatorId !== lobbyPlayerId(socket) || room.state !== "waiting" || !roomReadyToStart(room)) {
      if (typeof reply === "function") reply({ success: false, message: "Only the host can start once all players are ready." });
      return;
    }
    clearCountdown(code);
    beginRound(code);
    if (typeof reply === "function") reply({ success: true });
  });

  // ── Set Turn Timer ──
  socket.on("set-turn-duration", ({ code, turnDuration }) => {
    const room = rooms[code];
    if (!room || room.gameMode !== "word-duel" || room.state !== "waiting" || room.creatorId !== lobbyPlayerId(socket)) return;

    room.turnDuration = sanitizeTurnDuration(turnDuration);
    io.to(code).emit("turn-duration-update", {
      turnDuration: room.turnDuration,
      creatorId: room.creatorId,
    });
  });

  socket.on("set-round-limit", ({ code, roundLimit }) => {
    const room = rooms[code];
    if (!room || room.gameMode !== "word-duel" || room.state !== "waiting" || room.creatorId !== lobbyPlayerId(socket)) return;

    room.roundLimit = sanitizeRoundLimit(roundLimit);
    io.to(code).emit("round-limit-update", {
      roundLimit: room.roundLimit,
      creatorId: room.creatorId,
    });
  });

  // ── Toggle Ready ──
  socket.on("toggle-ready", ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== "waiting") return;
    const player = room.players.find((p) => p.id === lobbyPlayerId(socket));
    if (!player) return;
    player.ready = !player.ready;
    broadcastReadyState(code, lobbyPlayerId(socket));
    const allReady = roomReadyToStart(room);
    if (allReady) startCountdown(code);
    else clearCountdown(code);
  });

  socket.on("slot-machine-done", ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== "slotting" || !room.pendingCategory) return;
    if (!room.players.some((p) => p.id === lobbyPlayerId(socket))) return;

    if (!(room.slotDoneIds instanceof Set)) room.slotDoneIds = new Set();
    room.slotDoneIds.add(lobbyPlayerId(socket));

    const allDone =
      room.players.length >= 2 &&
      getHumanPlayers(room).every((p) => room.slotDoneIds.has(p.id));

    if (allDone) startGame(code);
  });

  // ── Chat Message ──
  socket.on("chat-message", ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === lobbyPlayerId(socket));
    if (!player) return;
    const trimmed = text?.trim();
    if (!trimmed || trimmed.length > 200) return;
    const msg = {
      id: Date.now() + Math.random(),
      playerId: lobbyPlayerId(socket),
      username: player.username,
      text: trimmed,
      timestamp: Date.now(),
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 100) room.chatHistory.shift();
    io.to(code).emit("chat-message", msg);
  });

  // ── Ask Letter ── (now sends prompt to opponent instead of auto-resolving)
  socket.on("ask-letter", ({ code, letter }) => {
    const room = rooms[code];
    if (!room || room.gameMode !== "word-duel" || room.state !== "playing") return;
    if (room.currentTurn !== lobbyPlayerId(socket)) { socket.emit("not-your-turn"); return; }
    if (room.pendingLetterAsk) { socket.emit("action-pending"); return; }

    letter = letter.toUpperCase();
    const opponent = getOpponent(room, lobbyPlayerId(socket));
    if (!opponent) return;

    // Store pending ask
    room.pendingLetterAsk = { askerId: lobbyPlayerId(socket), letter };
    clearTurnTimer(code);

    // Notify asker that we're waiting
    socket.emit("waiting-for-response", { action: "letter-ask", letter });

    if (isBotPlayer(opponent)) {
      const hasLetter = getLetterFrequency(room.words[opponent.id], letter) > 0;
      setTimeout(() => answerPendingLetterAsk(code, opponent.id, hasLetter), 700);
      return;
    }

    // Prompt opponent
    io.to(opponent.id).emit("letter-ask-prompt", {
      askerName: room.players.find((p) => p.id === lobbyPlayerId(socket)).username,
      letter,
    });
  });

  // ── Answer Letter Ask ── (opponent responds Yes/No)
  socket.on("answer-letter-ask", ({ code, answer }) => {
    answerPendingLetterAsk(code, lobbyPlayerId(socket), answer);
  });

  // ── Ask Letter Count ──
  socket.on("ask-letter-count", ({ code, letter }) => {
    const room = rooms[code];
    if (!room || room.gameMode !== "word-duel" || room.state !== "playing") return;
    if (room.currentTurn !== lobbyPlayerId(socket)) { socket.emit("not-your-turn"); return; }
    if (room.pendingLetterCount) { socket.emit("action-pending"); return; }

    letter = letter.toUpperCase();
    const opponent = getOpponent(room, lobbyPlayerId(socket));
    if (!opponent) return;

    room.pendingLetterCount = { askerId: lobbyPlayerId(socket), letter };
    clearTurnTimer(code);

    socket.emit("waiting-for-response", { action: "letter-count", letter });

    if (isBotPlayer(opponent)) {
      const count = getLetterFrequency(room.words[opponent.id], letter);
      setTimeout(() => answerPendingLetterCount(code, opponent.id, count), 700);
      return;
    }

    io.to(opponent.id).emit("letter-count-prompt", {
      askerName: room.players.find((p) => p.id === lobbyPlayerId(socket)).username,
      letter,
    });
  });

  // ── Answer Letter Count ──
  socket.on("answer-letter-count", ({ code, count }) => {
    answerPendingLetterCount(code, lobbyPlayerId(socket), count);
  });

  // ── Guess Word ──
  socket.on("guess-word", ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.gameMode !== "word-duel" || room.state !== "playing") return;
    if (room.currentTurn !== lobbyPlayerId(socket)) { socket.emit("not-your-turn"); return; }
    finishGuess(code, lobbyPlayerId(socket), guess);
  });

  // ── Rematch ──
  socket.on("rematch", ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== "ended" || !room.players.some((p) => p.id === lobbyPlayerId(socket))) return;
    if (room.gameMode === "color-card" && room.colorMatch?.history.length < room.colorMatch?.targets.length) return;
    if (room.seriesOver && room.roundLimit > 1) {
      room.players.forEach((p) => (p.wins = 0));
    }
    room.seriesOver = false;
    room.players.forEach((p) => (p.ready = isBotPlayer(p)));
    room.state = "waiting";
    room.pendingCategory = null;
    room.slotDoneIds = null;
    clearCountdown(code);
    clearTurnTimer(code);
    clearBotTimer(code);
    colorCardRounds.clear(code);
    room.colorRound = null;
    room.colorMatch = null;
    room.colorRanking = null;
    io.to(code).emit("rematch-lobby", lobbyState(room));
  });

  socket.on("leave-room", (payload = {}, reply) => {
    if (payload?.code !== socket.data.lobbyCode || !rooms[payload?.code]?.players.some((player) => player.id === lobbyPlayerId(socket))) {
      if (typeof reply === "function") reply({ success: false, message: "You are not in this room." });
      return;
    }
    leaveRoom(socket);
    if (typeof reply === "function") reply({ success: true });
  });

  // ── Disconnect ──
  socket.on("disconnect", (reason) => {
    console.log(`[-] Disconnected: ${lobbyPlayerId(socket)}`);
    const room = rooms[socket.data.lobbyCode];
    const player = room?.players.find((candidate) => candidate.id === lobbyPlayerId(socket));
    if (!player || player.socketId !== socket.id) return;
    if (["client namespace disconnect", "server namespace disconnect", "server shutting down"].includes(reason)) { leaveRoom(socket, true); return; }
    reserveSeat(room, player, socket, true);
  });
});

// ─── Game Functions ───────────────────────────────────────────────────────────

function beginSlotMachine(code) {
  const room = rooms[code];
  if (!room || room.state !== "waiting" || !roomReadyToStart(room)) return;

  const category = pickCategory(room);
  if (!category) return;
  room.category = category.name;
  room.pendingCategory = category;
  room.slotDoneIds = new Set();
  room.state = "slotting";

  io.to(code).emit("category-selected", {
    category: category.name,
    selectedCategoryName: category.name,
  });

  console.log(`[Slot] ${code} | ${category.name}`);
}

function getOpponent(room, playerId) {
  // The next seat is the fixed opponent; with two players this is the existing duel.
  const index = room.players.findIndex((p) => p.id === playerId);
  return index < 0 ? null : room.players[(index + 1) % room.players.length];
}

function getLetterFrequency(word, letter) {
  const normalizedLetter = String(letter || "").toUpperCase();
  return String(word || "")
    .toUpperCase()
    .split("")
    .filter((char) => char === normalizedLetter).length;
}

function answerPendingLetterAsk(code, responderId, answer) {
  const room = rooms[code];
  if (!room || room.state !== "playing" || !room.pendingLetterAsk) return;

  const { askerId, letter } = room.pendingLetterAsk;
  if (responderId !== getOpponent(room, askerId)?.id) return;

  const asker = room.players.find((p) => p.id === askerId);
  const responder = room.players.find((p) => p.id === responderId);
  if (!asker || !responder) return;

  room.pendingLetterAsk = null;
  const hasLetter = answer === true || answer === "yes";

  if (hasLetter) {
    const counts = getConfirmedLetterCounts(room, askerId);
    setConfirmedLetterCount(room, askerId, letter, Math.max(counts[letter] || 0, 1));
  }
  room.askedLetters[askerId] ||= {};
  room.askedLetters[askerId][letter] = hasLetter ? "yes" : "no";

  io.to(code).emit("letter-result", {
    askerId,
    askerName: asker.username,
    letter,
    hasLetter,
    confirmedLetters: getExpandedConfirmedLetters(room, askerId),
  });

  passTurn(code);
}

function answerPendingLetterCount(code, responderId, count) {
  const room = rooms[code];
  if (!room || room.state !== "playing" || !room.pendingLetterCount) return;

  const { askerId, letter } = room.pendingLetterCount;
  if (responderId !== getOpponent(room, askerId)?.id) return;

  const asker = room.players.find((p) => p.id === askerId);
  const responder = room.players.find((p) => p.id === responderId);
  const numCount = parseInt(count, 10);
  if (!asker || !responder || isNaN(numCount) || numCount < 0) return;

  room.pendingLetterCount = null;
  room.askedLetters[askerId] ||= {};
  room.askedLetters[askerId][letter] = numCount > 0 ? "yes" : "no";
  setConfirmedLetterCount(room, askerId, letter, numCount);

  io.to(code).emit("letter-count-result", {
    askerId,
    askerName: asker.username,
    responderName: responder.username,
    letter,
    count: numCount,
    confirmedLetters: getExpandedConfirmedLetters(room, askerId),
  });

  passTurn(code);
}

function getSeriesState(room, winnerId) {
  const roundLimit = sanitizeRoundLimit(room.roundLimit);
  const winsToSeries = getWinsToSeries(roundLimit);
  const winner = room.players.find((p) => p.id === winnerId);
  const roundNumber = room.players.reduce((total, p) => total + (p.wins || 0), 0);
  const seriesOver = Boolean(winner && (winner.wins || 0) >= winsToSeries);

  return {
    roundLimit,
    roundNumber,
    winsToSeries,
    seriesOver,
    seriesWinnerId: seriesOver ? winner.id : null,
    seriesWinnerName: seriesOver ? winner.username : null,
  };
}

function finishGuess(code, guesserId, guess) {
  const room = rooms[code];
  if (!room || room.state !== "playing") return;
  if (room.currentTurn !== guesserId) return;

  const opponent = getOpponent(room, guesserId);
  const guesser = room.players.find((p) => p.id === guesserId);
  if (!opponent || !guesser) return;

  const opponentWord = normalizeWord(room.words[opponent.id] || "");
  const normalizedGuess = normalizeWord(guess);
  const correct = normalizedGuess === opponentWord;

  if (!room.guessAttempts[guesserId]) room.guessAttempts[guesserId] = 0;
  room.guessAttempts[guesserId]++;

  if (correct) {
    clearTurnTimer(code);
    clearBotTimer(code);
    room.state = "ended";
    guesser.wins = (guesser.wins || 0) + 1;
    const seriesState = getSeriesState(room, guesserId);
    room.seriesOver = seriesState.seriesOver;

    room.lastResult = {
      winnerId: guesserId,
      winnerName: guesser.username,
      winnerWins: guesser.wins,
      players: publicPlayers(room),
      correctWord: room.words[opponent.id],
      loserWord: room.words[guesserId],
      wordsByPlayer: room.words,
      opponentsByPlayer: Object.fromEntries(room.players.map((player) => [player.id, getOpponent(room, player.id).id])),
      ...seriesState,
    };
    io.to(code).emit("game-over", room.lastResult);
    return;
  }

  io.to(code).emit("wrong-guess", {
    guesserId,
    guesserName: guesser.username,
    guess,
  });
  passTurn(code);
}

function hasRequiredLetterCounts(word, counts) {
  return Object.entries(counts).every(
    ([letter, count]) => getLetterFrequency(word, letter) >= count,
  );
}

function getBotCandidates(room, botId, targetId) {
  const category = room.categoryData;
  const targetLength = getLetterCount(room.words[targetId] || "");
  const confirmedCounts = getConfirmedLetterCounts(room, botId);
  const guessed = new Set((room.botGuesses[botId] || []).map(normalizeWord));
  const source = category ? getEligibleWords(category) : [];
  const candidates = source.filter(
    (word) =>
      getLetterCount(word) === targetLength &&
      hasRequiredLetterCounts(word, confirmedCounts) &&
      !guessed.has(normalizeWord(word)),
  );

  return candidates.length ? candidates : source.filter((word) => getLetterCount(word) === targetLength);
}

function chooseBotLetter(room, botId, targetId, candidates) {
  const asked = room.botAskedLetters[botId] || [];
  const askedSet = new Set(asked);
  const confirmed = getConfirmedLetterCounts(room, botId);
  const candidateLetters = candidates
    .join("")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .split("")
    .filter((letter) => !askedSet.has(letter) && !confirmed[letter]);
  const commonLetters = "ETAOINSHRDLUCMFWYPVBGKQJXZ".split("");
  const pool = candidateLetters.length ? candidateLetters : commonLetters;
  const scored = pool.reduce((counts, letter) => {
    if (!askedSet.has(letter) && !confirmed[letter]) counts[letter] = (counts[letter] || 0) + 1;
    return counts;
  }, {});
  const sorted = Object.entries(scored).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || commonLetters.find((letter) => !askedSet.has(letter)) || "E";
}

function scheduleBotTurnIfNeeded(code) {
  const room = rooms[code];
  if (!room || room.state !== "playing" || room.pausedAt) return;
  clearBotTimer(code);

  const bot = room.players.find((p) => p.id === room.currentTurn && isBotPlayer(p));
  if (!bot || room.pendingLetterAsk || room.pendingLetterCount) return;

  room.botActionTimer = setTimeout(() => runBotTurn(code), 900 + Math.random() * 800);
}

function runBotTurn(code) {
  const room = rooms[code];
  if (!room || room.state !== "playing" || room.pausedAt) return;
  const bot = room.players.find((p) => p.id === room.currentTurn && isBotPlayer(p));
  if (!bot || room.pendingLetterAsk || room.pendingLetterCount) return;

  const human = getOpponent(room, bot.id);
  if (!human) return;

  const candidates = getBotCandidates(room, bot.id, human.id);
  const confirmedCounts = getConfirmedLetterCounts(room, bot.id);
  const knownLetterCount = Object.values(confirmedCounts).reduce((total, count) => total + count, 0);
  const askedCount = (room.botAskedLetters[bot.id] || []).length;
  const countAskedSet = new Set(room.botCountAskedLetters[bot.id] || []);
  const countableLetters = Object.entries(confirmedCounts)
    .filter(([letter, count]) => count > 0 && !countAskedSet.has(letter))
    .map(([letter]) => letter);
  const shouldGuess =
    candidates.length === 1 ||
    (candidates.length <= 3 && knownLetterCount >= 2) ||
    (askedCount >= 6 && candidates.length > 0 && Math.random() < 0.45);

  if (shouldGuess && candidates.length) {
    const guess = candidates[Math.floor(Math.random() * candidates.length)];
    if (!room.botGuesses[bot.id]) room.botGuesses[bot.id] = [];
    room.botGuesses[bot.id].push(guess);
    finishGuess(code, bot.id, guess);
    return;
  }

  if (countableLetters.length > 0 && Math.random() < 0.25) {
    const letter = countableLetters[Math.floor(Math.random() * countableLetters.length)];
    if (!room.botCountAskedLetters[bot.id]) room.botCountAskedLetters[bot.id] = [];
    room.botCountAskedLetters[bot.id].push(letter);
    clearTurnTimer(code);
    room.pendingLetterCount = { askerId: bot.id, letter };
    io.to(human.id).emit("letter-count-prompt", {
      askerName: bot.username,
      letter,
    });
    return;
  }

  const letter = chooseBotLetter(room, bot.id, human.id, candidates);
  if (!room.botAskedLetters[bot.id]) room.botAskedLetters[bot.id] = [];
  room.botAskedLetters[bot.id].push(letter);
  clearTurnTimer(code);

  room.pendingLetterAsk = { askerId: bot.id, letter };
  io.to(human.id).emit("letter-ask-prompt", {
    askerName: bot.username,
    letter,
  });
}

function startGame(code) {
  const room = rooms[code];
  if (!room || room.gameMode !== "word-duel" || room.players.length < 2 || room.state !== "slotting") return;

  const category = room.pendingCategory || pickCategory(room);
  if (!category) return;
  room.category = category.name;
  room.categoryData = category;
  room.state = "playing";
  room.pendingCategory = null;
  room.slotDoneIds = null;
  room.words = {};
  room.confirmedLetters = {};
  room.askedLetters = {};
  room.guessAttempts = {};
  room.botAskedLetters = {};
  room.botCountAskedLetters = {};
  room.botGuesses = {};
  room.pendingLetterAsk = null;
  room.pendingLetterCount = null;
  room.players.forEach((p) => (p.ready = false));

  const [word1, word2] = pickWordPair(category);

  room.words[room.players[0].id] = word1;
  room.words[room.players[1].id] = word2;
  room.players.slice(2).forEach((p) => { room.words[p.id] = pickWord(category); });
  room.currentTurn = room.players[Math.floor(Math.random() * room.players.length)].id;

  room.players.forEach((p) => {
    const myWord = room.words[p.id];
    const opponent = getOpponent(room, p.id);
    const opponentWord = room.words[opponent.id];
    if (isBotPlayer(p)) return;
    io.to(p.id).emit("game-start", {
      gameMode: room.gameMode,
      opponentId: opponent.id,
      category: category.name,
      myWord,
      myWordLetterCount: getLetterCount(myWord),
      opponentLetterCount: getLetterCount(opponentWord),
      currentTurn: room.currentTurn,
      players: publicPlayers(room),
      turnDuration: room.turnDuration,
      roundLimit: room.roundLimit,
    });
  });

  const currentPlayer = room.players.find((p) => p.id === room.currentTurn);
  if (isBotPlayer(currentPlayer)) scheduleBotTurnIfNeeded(code);
  else if (room.turnDuration > 0) startTurnTimer(code);

  console.log(`[Game] ${code} | ${category.name} | ${word1} vs ${word2}`);
}

function passTurn(code, fromTimeout = false) {
  const room = rooms[code];
  if (!room) return;
  const other = getOpponent(room, room.currentTurn);
  if (other) {
    room.currentTurn = other.id;
    room.pendingLetterAsk = null;
    room.pendingLetterCount = null;
    io.to(code).emit("turn-change", { currentTurn: room.currentTurn, fromTimeout });
    if (isBotPlayer(other)) scheduleBotTurnIfNeeded(code);
    else if (room.turnDuration > 0) startTurnTimer(code);
  }
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Game lobby server running on port ${server.address().port}`));
}

module.exports = { server, io };
