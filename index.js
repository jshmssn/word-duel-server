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

function broadcastReadyState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("ready-update", {
    players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
  });
}

// ─── Countdown logic ─────────────────────────────────────────────────────────

function startCountdown(code) {
  const room = rooms[code];
  if (!room) return;

  // Clear any existing countdown
  clearCountdown(code);

  // 2 second delay before countdown starts
  room.countdownDelay = setTimeout(() => {
    // Double-check both still ready
    if (!rooms[code] || !rooms[code].players.every((p) => p.ready) || rooms[code].players.length !== 2) return;

    let count = 5;
    io.to(code).emit("countdown", { count });

    room.countdownInterval = setInterval(() => {
      if (!rooms[code]) { clearInterval(room.countdownInterval); return; }
      count--;
      if (count <= 0) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
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

// ─── Socket Events ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on("create-room", ({ username }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
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
    };

    socket.join(code);
    socket.emit("room-created", { code });
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

    // Send chat history to newcomer
    socket.emit("chat-history", { messages: room.chatHistory });

    io.to(code).emit("player-joined", {
      players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
    });

    console.log(`[Room] ${username} joined ${code}`);
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

    if (allReady) {
      startCountdown(code);
    } else {
      // Someone un-readied, cancel countdown
      clearCountdown(code);
    }
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
    // Keep only last 100 messages
    if (room.chatHistory.length > 100) room.chatHistory.shift();

    io.to(code).emit("chat-message", msg);
  });

  // ── Ask Letter ──
  socket.on("ask-letter", ({ code, letter }) => {
    const room = rooms[code];
    if (!room || room.state !== "playing") return;
    if (room.currentTurn !== socket.id) { socket.emit("not-your-turn"); return; }

    letter = letter.toUpperCase();
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (!opponent) return;

    const opponentWord = normalizeWord(room.words[opponent.id] || "");
    const hasLetter = opponentWord.includes(letter.toLowerCase());

    if (hasLetter) {
      if (!room.confirmedLetters[socket.id]) room.confirmedLetters[socket.id] = new Set();
      room.confirmedLetters[socket.id].add(letter);
    }

    io.to(code).emit("letter-result", {
      askerId: socket.id,
      askerName: room.players.find((p) => p.id === socket.id).username,
      letter,
      hasLetter,
      confirmedLetters: [...(room.confirmedLetters[socket.id] || [])],
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

    // Reset all players to not-ready for rematch lobby
    room.players.forEach((p) => (p.ready = false));
    room.state = "waiting";
    clearCountdown(code);

    io.to(code).emit("rematch-lobby", {
      players: room.players.map((p) => ({ id: p.id, username: p.username, ready: p.ready })),
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
        room.players.splice(idx, 1);
        io.to(code).emit("player-left", { username: left.username });
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`[Room] ${code} deleted`);
        } else {
          room.state = "waiting";
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
    });
  });

  console.log(`[Game] ${code} | ${category.name} | ${word1} vs ${word2}`);
}

function passTurn(code) {
  const room = rooms[code];
  if (!room) return;
  const other = room.players.find((p) => p.id !== room.currentTurn);
  if (other) {
    room.currentTurn = other.id;
    io.to(code).emit("turn-change", { currentTurn: room.currentTurn });
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Word Duel server running on port ${PORT}`));
