const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const wordsData = require("./words.json");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {};

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
  }));
}

function broadcastReadyState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("ready-update", {
    players: publicPlayers(room),
    creatorId: room.creatorId,
  });
}

function roomReadyToStart(room) {
  return room.players.length === 2 && room.players.every((p) => p.ready);
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
        beginSlotMachine(code);
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

function startTurnTimer(code) {
  const room = rooms[code];
  if (!room || !room.turnDuration) return;
  const currentPlayer = room.players.find((p) => p.id === room.currentTurn);
  if (isBotPlayer(currentPlayer)) return;
  clearTurnTimer(code);

  let remaining = room.turnDuration;
  io.to(code).emit("timer-update", { remaining, total: room.turnDuration });

  room.turnTimerInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(room.turnTimerInterval); return; }
    remaining--;
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

function createRoomState(code, creatorId, username, { withBot = false } = {}) {
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
  };
}

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on("create-room", ({ username }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = createRoomState(code, socket.id, username);

    socket.join(code);
    socket.emit("room-created", {
      code,
      creatorId: socket.id,
      turnDuration: rooms[code].turnDuration,
      roundLimit: rooms[code].roundLimit,
      players: publicPlayers(rooms[code]),
    });
    console.log(`[Room] ${code} created by ${username}`);
  });

  socket.on("create-bot-room", ({ username }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = createRoomState(code, socket.id, username, { withBot: true });

    socket.join(code);
    socket.emit("room-created", {
      code,
      creatorId: socket.id,
      turnDuration: rooms[code].turnDuration,
      roundLimit: rooms[code].roundLimit,
      players: publicPlayers(rooms[code]),
      mode: rooms[code].mode,
    });
    console.log(`[Bot Room] ${code} created by ${username}`);
  });

  // ── Join Room ──
  socket.on("join-room", ({ code, username }) => {
    const room = rooms[code];
    if (!room) { socket.emit("join-error", { message: "Room not found." }); return; }
    if (room.players.length >= 2) { socket.emit("join-error", { message: "Room is full." }); return; }
    if (room.state !== "waiting") { socket.emit("join-error", { message: "Game already in progress." }); return; }

    room.players.push({ id: socket.id, username, ready: false, wins: 0 });
    socket.join(code);

    socket.emit("chat-history", { messages: room.chatHistory });

    io.to(code).emit("player-joined", {
      players: publicPlayers(room),
      turnDuration: room.turnDuration,
      roundLimit: room.roundLimit,
      creatorId: room.creatorId,
      mode: room.mode,
    });

    console.log(`[Room] ${username} joined ${code}`);
  });

  // ── Set Turn Timer ──
  socket.on("set-turn-duration", ({ code, turnDuration }) => {
    const room = rooms[code];
    if (!room || room.state !== "waiting" || room.creatorId !== socket.id) return;

    room.turnDuration = sanitizeTurnDuration(turnDuration);
    io.to(code).emit("turn-duration-update", {
      turnDuration: room.turnDuration,
      creatorId: room.creatorId,
    });
  });

  socket.on("set-round-limit", ({ code, roundLimit }) => {
    const room = rooms[code];
    if (!room || room.state !== "waiting" || room.creatorId !== socket.id) return;

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
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastReadyState(code);
    const allReady = room.players.length === 2 && room.players.every((p) => p.ready);
    if (allReady) startCountdown(code);
    else clearCountdown(code);
  });

  socket.on("slot-machine-done", ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== "slotting" || !room.pendingCategory) return;
    if (!room.players.some((p) => p.id === socket.id)) return;

    if (!(room.slotDoneIds instanceof Set)) room.slotDoneIds = new Set();
    room.slotDoneIds.add(socket.id);

    const allDone =
      room.players.length === 2 &&
      getHumanPlayers(room).every((p) => room.slotDoneIds.has(p.id));

    if (allDone) startGame(code);
  });

  // ── Chat Message ──
  socket.on("chat-message", ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    const trimmed = text?.trim();
    if (!trimmed || trimmed.length > 200) return;
    const msg = {
      id: Date.now() + Math.random(),
      playerId: socket.id,
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
    if (!room || room.state !== "playing") return;
    if (room.currentTurn !== socket.id) { socket.emit("not-your-turn"); return; }
    if (room.pendingLetterAsk) { socket.emit("action-pending"); return; }

    letter = letter.toUpperCase();
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (!opponent) return;

    // Store pending ask
    room.pendingLetterAsk = { askerId: socket.id, letter };
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
      askerName: room.players.find((p) => p.id === socket.id).username,
      letter,
    });
  });

  // ── Answer Letter Ask ── (opponent responds Yes/No)
  socket.on("answer-letter-ask", ({ code, answer }) => {
    answerPendingLetterAsk(code, socket.id, answer);
  });

  // ── Ask Letter Count ──
  socket.on("ask-letter-count", ({ code, letter }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (room.currentTurn !== socket.id) { socket.emit("not-your-turn"); return; }
    if (room.pendingLetterCount) { socket.emit("action-pending"); return; }

    letter = letter.toUpperCase();
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (!opponent) return;

    room.pendingLetterCount = { askerId: socket.id, letter };
    clearTurnTimer(code);

    socket.emit("waiting-for-response", { action: "letter-count", letter });

    if (isBotPlayer(opponent)) {
      const count = getLetterFrequency(room.words[opponent.id], letter);
      setTimeout(() => answerPendingLetterCount(code, opponent.id, count), 700);
      return;
    }

    io.to(opponent.id).emit("letter-count-prompt", {
      askerName: room.players.find((p) => p.id === socket.id).username,
      letter,
    });
  });

  // ── Answer Letter Count ──
  socket.on("answer-letter-count", ({ code, count }) => {
    answerPendingLetterCount(code, socket.id, count);
  });

  // ── Guess Word ──
  socket.on("guess-word", ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (room.currentTurn !== socket.id) { socket.emit("not-your-turn"); return; }
    finishGuess(code, socket.id, guess);
  });

  // ── Rematch ──
  socket.on("rematch", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
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
    io.to(code).emit("rematch-lobby", {
      players: publicPlayers(room),
      turnDuration: room.turnDuration,
      roundLimit: room.roundLimit,
      creatorId: room.creatorId,
    });
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const left = room.players[idx];
        clearCountdown(code);
        clearTurnTimer(code);
        clearBotTimer(code);
        room.players.splice(idx, 1);
        io.to(code).emit("player-left", { username: left.username, disconnected: true });
        if (room.players.length === 0 || room.players.every((p) => isBotPlayer(p))) {
          delete rooms[code];
          console.log(`[Room] ${code} deleted`);
        } else {
          room.state = "waiting";
          room.pendingCategory = null;
          room.slotDoneIds = null;
          if (!room.players.some((p) => p.id === room.creatorId)) {
            room.creatorId = room.players[0].id;
          }
          room.players.forEach((p) => (p.ready = isBotPlayer(p)));
          broadcastReadyState(code);
        }
        break;
      }
    }
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
  return room.players.find((p) => p.id !== playerId);
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
  if (responderId === askerId) return;

  const asker = room.players.find((p) => p.id === askerId);
  const responder = room.players.find((p) => p.id === responderId);
  if (!asker || !responder) return;

  room.pendingLetterAsk = null;
  const hasLetter = answer === true || answer === "yes";

  if (hasLetter) {
    const counts = getConfirmedLetterCounts(room, askerId);
    setConfirmedLetterCount(room, askerId, letter, Math.max(counts[letter] || 0, 1));
  }

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
  if (responderId === askerId) return;

  const asker = room.players.find((p) => p.id === askerId);
  const responder = room.players.find((p) => p.id === responderId);
  const numCount = parseInt(count, 10);
  if (!asker || !responder || isNaN(numCount) || numCount < 0) return;

  room.pendingLetterCount = null;
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

    io.to(code).emit("game-over", {
      winnerId: guesserId,
      winnerName: guesser.username,
      winnerWins: guesser.wins,
      players: publicPlayers(room),
      correctWord: room.words[opponent.id],
      loserWord: room.words[guesserId],
      wordsByPlayer: room.words,
      ...seriesState,
    });
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
  if (!room || room.state !== "playing") return;
  clearBotTimer(code);

  const bot = room.players.find((p) => p.id === room.currentTurn && isBotPlayer(p));
  if (!bot || room.pendingLetterAsk || room.pendingLetterCount) return;

  room.botActionTimer = setTimeout(() => runBotTurn(code), 900 + Math.random() * 800);
}

function runBotTurn(code) {
  const room = rooms[code];
  if (!room || room.state !== "playing") return;
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
  if (!room || room.players.length !== 2 || room.state === "playing") return;

  const category = room.pendingCategory || pickCategory(room);
  if (!category) return;
  room.category = category.name;
  room.categoryData = category;
  room.state = "playing";
  room.pendingCategory = null;
  room.slotDoneIds = null;
  room.words = {};
  room.confirmedLetters = {};
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
  room.currentTurn = room.players[Math.floor(Math.random() * 2)].id;

  room.players.forEach((p) => {
    const myWord = room.words[p.id];
    const opponentWord = room.words[room.players.find((op) => op.id !== p.id).id];
    if (isBotPlayer(p)) return;
    io.to(p.id).emit("game-start", {
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
  const other = room.players.find((p) => p.id !== room.currentTurn);
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
server.listen(PORT, () => console.log(`Word Duel server running on port ${PORT}`));
