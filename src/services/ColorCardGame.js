const crypto = require("node:crypto");

const ROUND_DURATION_MS = 30_000;
const MEMORIZE_DURATION_MS = 5_000;
const COLOR_CARD_COUNT = 5;
const COLOR_DURATIONS = [30, 45, 60];
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 ** 2);

function normalizeHex(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error("Submit a six-digit HEX color, such as #A34F2E.");
  }
  return value.toUpperCase();
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex);
  return [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
}

function colorDistance(first, second) {
  const target = hexToRgb(first);
  return Math.sqrt(hexToRgb(second).reduce((sum, channel, index) => sum + (channel - target[index]) ** 2, 0));
}

function colorDuration(value = 30) {
  const duration = Number(value);
  if (!COLOR_DURATIONS.includes(duration)) throw new Error("Choose 30 seconds, 45 seconds, or 1 minute.");
  return duration;
}

function colorCardCount(value = COLOR_CARD_COUNT) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Choose a whole number of cards from 1 to 100.");
  return count;
}

// Round rules contain no transport logic. Deadlines and randomness are injectable
// so timeout, tie, and late-submission behavior can be verified deterministically.
class ColorCardGame {
  constructor({ now = Date.now, randomColor = () => `#${crypto.randomBytes(3).toString("hex")}` } = {}) {
    this.now = now;
    this.randomColor = randomColor;
  }

  start(players, { durationSeconds = 30, targetColor = this.randomColor() } = {}) {
    const duration = colorDuration(durationSeconds);
    const memorizeEndsAt = this.now() + MEMORIZE_DURATION_MS;
    return {
      id: crypto.randomUUID(),
      targetColor: normalizeHex(targetColor),
      phase: "memorizing",
      memorizeEndsAt,
      endsAt: memorizeEndsAt + duration * 1000,
      durationSeconds: duration,
      players: players.map(({ id, username }) => ({ id, username })),
      submissions: new Map(),
      drafts: new Map(players.map((player) => [player.id, "#FFFFFF"])),
      autoSubmittedIds: new Set(),
      result: null,
    };
  }

  createMatch(players, durationSeconds = 30, cardCount = COLOR_CARD_COUNT) {
    const count = colorCardCount(cardCount);
    const used = new Set();
    const targets = Array.from({ length: count }, () => {
      let value = parseInt(normalizeHex(this.randomColor()).slice(1), 16);
      // Resolve a random collision without ever returning a repeated target.
      while (used.has(value)) value = (value + 1) % 0x1000000;
      used.add(value);
      return `#${value.toString(16).padStart(6, "0")}`.toUpperCase();
    });
    return {
      id: crypto.randomUUID(), durationSeconds: colorDuration(durationSeconds),
      targets,
      players: players.map(({ id, username }) => ({ id, username })),
      roundNumber: 0, currentRound: null, history: [],
    };
  }

  startNext(match) {
    if (match.currentRound && !match.currentRound.result) throw new Error("Finish the current card first.");
    if (match.roundNumber >= match.targets.length) throw new Error("All cards have been played.");
    match.currentRound = this.start(match.players, {
      durationSeconds: match.durationSeconds, targetColor: match.targets[match.roundNumber],
    });
    match.roundNumber += 1;
    return match.currentRound;
  }

  recordResult(match, result) {
    if (!match.history.some((card) => card.roundId === result.roundId)) match.history.push(result);
    const standings = match.players.map((player) => {
      const entries = match.history.map((card) => card.entries.find((entry) => entry.id === player.id));
      const totalAccuracy = entries.reduce((sum, entry) => sum + (entry?.accuracy || 0), 0);
      return { ...player, totalAccuracy, averageAccuracy: totalAccuracy / match.history.length,
        submittedCards: entries.filter((entry) => entry?.submittedColor).length };
    }).sort((a, b) => b.totalAccuracy - a.totalAccuracy);
    const matchComplete = match.history.length === match.targets.length;
    const best = standings.find((player) => player.submittedCards > 0)?.totalAccuracy;
    return {
      matchId: match.id, roundNumber: match.roundNumber, totalRounds: match.targets.length,
      matchComplete, standings,
      matchWinnerIds: matchComplete ? standings.filter((player) => player.submittedCards > 0 && player.totalAccuracy === best).map((player) => player.id) : [],
    };
  }

  requirePicking(round, playerId, roundId) {
    if (!round || round.result) throw new Error("This round is no longer accepting colors.");
    if (round.id !== roundId) throw new Error("That submission belongs to another round.");
    if (!round.players.some((player) => player.id === playerId)) throw new Error("You are not in this round.");
    if (this.now() < round.memorizeEndsAt) throw new Error("Memorize the target first. Picking begins when it disappears.");
    if (this.now() >= round.endsAt) throw new Error("The round timer has expired.");
  }

  submit(round, { playerId, hex, roundId }) {
    this.requirePicking(round, playerId, roundId);
    const color = normalizeHex(hex);
    round.drafts.set(playerId, color);
    round.submissions.set(playerId, color);
    return color;
  }

  updateDraft(round, { playerId, hex, roundId }) {
    this.requirePicking(round, playerId, roundId);
    const color = normalizeHex(hex);
    round.drafts.set(playerId, color);
    if (round.submissions.get(playerId) !== color) round.submissions.delete(playerId);
    return color;
  }

  edit(round, { playerId, roundId }) {
    this.requirePicking(round, playerId, roundId);
    round.submissions.delete(playerId);
    return round.drafts.get(playerId);
  }

  finish(round, reason) {
    if (round.result) return round.result;
    if (reason === "timeout") {
      round.players.forEach((player) => {
        if (!round.submissions.has(player.id)) {
          round.autoSubmittedIds.add(player.id);
        }
        round.submissions.set(player.id, round.drafts.get(player.id) || "#FFFFFF");
      });
    }
    const entries = round.players.map((player) => {
      const submittedColor = round.submissions.get(player.id) || null;
      const distance = submittedColor === null ? null : colorDistance(round.targetColor, submittedColor);
      return {
        ...player, submittedColor, distance, autoSubmitted: round.autoSubmittedIds.has(player.id),
        accuracy: distance === null ? null : Math.max(0, (1 - distance / MAX_RGB_DISTANCE) * 100),
      };
    }).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const bestDistance = entries.find((entry) => entry.distance !== null)?.distance;
    const winners = entries.filter((entry) => entry.distance !== null && entry.distance === bestDistance);
    round.result = {
      gameMode: "color-card", roundId: round.id, targetColor: round.targetColor,
      entries, winners: winners.map(({ id, username }) => ({ id, username })),
      winnerIds: winners.map(({ id }) => id), reason,
    };
    return round.result;
  }
}

module.exports = { ColorCardGame, normalizeHex, hexToRgb, colorDistance, colorDuration, colorCardCount, COLOR_DURATIONS, COLOR_CARD_COUNT, ROUND_DURATION_MS, MEMORIZE_DURATION_MS, MAX_RGB_DISTANCE };
