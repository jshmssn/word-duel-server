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

function pickCategory() {
  return wordsData.categories[Math.floor(Math.random() * wordsData.categories.length)];
}

function pickWord(category) {
  const eligible = category.words.filter((w) => {
    const letters = w.replace(/[^a-zA-Z]/g, "");
    return letters.length >= 5 && letters.length <= 10;
  });
  if (!eligible.length) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

function getLetterCount(word) {
  return word.replace(/[^a-zA-Z]/g, "").length;
}

function normalizeWord(word) {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

function sanitizeTurnDuration(turnDuration) {
  const duration = Number(turnDuration) || 0;
  return [0, 30, 45, 60].includes(duration) ? duration : 0;
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

function broadcastReadyState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("ready-update", {
    players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
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
        startGame(code);
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

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on("create-room", ({ username }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      creatorId: socket.id,
      players: [{ id: socket.id, username, ready: false }],
      state: "waiting",
      currentTurn: null,
      category: null,
      words: {},
      confirmedLetters: {},
      guessAttempts: {},
      chatHistory: [],
      countdownDelay: null,
      countdownInterval: null,
      // Turn timer: 0 means no timer
      turnDuration: 0,
      turnTimerInterval: null,
      // Pending letter ask
      pendingLetterAsk: null,
      // Pending letter count ask
      pendingLetterCount: null,
    };

    socket.join(code);
    socket.emit("room-created", {
      code,
      creatorId: socket.id,
      turnDuration: rooms[code].turnDuration,
    });
    console.log(`[Room] ${code} created by ${username}`);
  });

  // ── Join Room ──
  socket.on("join-room", ({ code, username }) => {
    const room = rooms[code];
    if (!room) { socket.emit("join-error", { message: "Room not found." }); return; }
    if (room.players.length >= 2) { socket.emit("join-error", { message: "Room is full." }); return; }
    if (room.state === "playing") { socket.emit("join-error", { message: "Game already in progress." }); return; }

    room.players.push({ id: socket.id, username, ready: false });
    socket.join(code);

    socket.emit("chat-history", { messages: room.chatHistory });

    io.to(code).emit("player-joined", {
      players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
      turnDuration: room.turnDuration,
      creatorId: room.creatorId,
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

  // ── Toggle Ready ──
  socket.on("toggle-ready", ({ code }) => {
    const room = rooms[code];
    if (!room || room.state === "playing") return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastReadyState(code);
    const allReady = room.players.length === 2 && room.players.every((p) => p.ready);
    if (allReady) startCountdown(code);
    else clearCountdown(code);
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

    // Notify asker that we're waiting
    socket.emit("waiting-for-response", { action: "letter-ask", letter });

    // Prompt opponent
    io.to(opponent.id).emit("letter-ask-prompt", {
      askerName: room.players.find((p) => p.id === socket.id).username,
      letter,
    });
  });

  // ── Answer Letter Ask ── (opponent responds Yes/No)
  socket.on("answer-letter-ask", ({ code, answer }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (!room.pendingLetterAsk) return;

    const { askerId, letter } = room.pendingLetterAsk;
    room.pendingLetterAsk = null;

    // Verify this is actually the opponent of the asker
    const opponent = room.players.find((p) => p.id === askerId);
    if (!opponent || socket.id === askerId) return;

    const hasLetter = answer === true || answer === "yes";

    if (hasLetter) {
      const counts = getConfirmedLetterCounts(room, askerId);
      setConfirmedLetterCount(room, askerId, letter, Math.max(counts[letter] || 0, 1));
    }

    io.to(code).emit("letter-result", {
      askerId,
      askerName: room.players.find((p) => p.id === askerId).username,
      letter,
      hasLetter,
      confirmedLetters: getExpandedConfirmedLetters(room, askerId),
    });

    passTurn(code);
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

    socket.emit("waiting-for-response", { action: "letter-count", letter });

    io.to(opponent.id).emit("letter-count-prompt", {
      askerName: room.players.find((p) => p.id === socket.id).username,
      letter,
    });
  });

  // ── Answer Letter Count ──
  socket.on("answer-letter-count", ({ code, count }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (!room.pendingLetterCount) return;

    const { askerId, letter } = room.pendingLetterCount;
    room.pendingLetterCount = null;

    if (socket.id === askerId) return;

    const numCount = parseInt(count, 10);
    if (isNaN(numCount) || numCount < 0) return;

    setConfirmedLetterCount(room, askerId, letter, numCount);

    io.to(code).emit("letter-count-result", {
      askerId,
      askerName: room.players.find((p) => p.id === askerId)?.username,
      responderName: room.players.find((p) => p.id === socket.id)?.username,
      letter,
      count: numCount,
      confirmedLetters: getExpandedConfirmedLetters(room, askerId),
    });

    passTurn(code);
  });

  // ── Guess Word ──
  socket.on("guess-word", ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (room.currentTurn !== socket.id) { socket.emit("not-your-turn"); return; }

    const opponent = room.players.find((p) => p.id !== socket.id);
    const guesser = room.players.find((p) => p.id === socket.id);
    if (!opponent) return;

    const opponentWord = normalizeWord(room.words[opponent.id] || "");
    const normalizedGuess = normalizeWord(guess);
    const correct = normalizedGuess === opponentWord;

    if (!room.guessAttempts[socket.id]) room.guessAttempts[socket.id] = 0;
    room.guessAttempts[socket.id]++;

    if (correct) {
      clearTurnTimer(code);
      room.state = "ended";
      io.to(code).emit("game-over", {
        winnerId: socket.id,
        winnerName: guesser.username,
        correctWord: room.words[opponent.id],
        loserWord: room.words[socket.id],
      });
    } else {
      io.to(code).emit("wrong-guess", {
        guesserId: socket.id,
        guesserName: guesser.username,
        guess,
      });
      passTurn(code);
    }
  });

  // ── Rematch ──
  socket.on("rematch", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.players.forEach((p) => (p.ready = false));
    room.state = "waiting";
    clearCountdown(code);
    clearTurnTimer(code);
    io.to(code).emit("rematch-lobby", {
      players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
      turnDuration: room.turnDuration,
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
        room.players.splice(idx, 1);
        io.to(code).emit("player-left", { username: left.username, disconnected: true });
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`[Room] ${code} deleted`);
        } else {
          room.state = "waiting";
          if (!room.players.some((p) => p.id === room.creatorId)) {
            room.creatorId = room.players[0].id;
          }
          room.players.forEach((p) => (p.ready = false));
          broadcastReadyState(code);
        }
        break;
      }
    }
  });
});

// ─── Game Functions ───────────────────────────────────────────────────────────

function startGame(code) {
  const room = rooms[code];
  if (!room || room.players.length !== 2) return;

  const category = pickCategory();
  room.category = category.name;
  room.state = "playing";
  room.confirmedLetters = {};
  room.guessAttempts = {};
  room.pendingLetterAsk = null;
  room.pendingLetterCount = null;
  room.players.forEach((p) => (p.ready = false));

  let word1 = pickWord(category);
  let word2 = pickWord(category);
  let attempts = 0;
  while (word2 === word1 && attempts < 20) { word2 = pickWord(category); attempts++; }

  room.words[room.players[0].id] = word1;
  room.words[room.players[1].id] = word2;
  room.currentTurn = room.players[Math.floor(Math.random() * 2)].id;

  room.players.forEach((p) => {
    const myWord = room.words[p.id];
    const opponentWord = room.words[room.players.find((op) => op.id !== p.id).id];
    io.to(p.id).emit("game-start", {
      category: category.name,
      myWord,
      myWordLetterCount: getLetterCount(myWord),
      opponentLetterCount: getLetterCount(opponentWord),
      currentTurn: room.currentTurn,
      players: room.players.map((pl) => ({ id: pl.id, username: pl.username })),
      turnDuration: room.turnDuration,
    });
  });

  if (room.turnDuration > 0) startTurnTimer(code);

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
    if (room.turnDuration > 0) startTurnTimer(code);
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Word Duel server running on port ${PORT}`));
