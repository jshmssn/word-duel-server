# Finish the Word: implementation and setup

Finish the Word is integrated into the existing React game hub as mode ID `finish-word`. It supports 2–8 players, exclusive character selection, server-controlled word-chain turns, live typing above characters, and the existing room recovery/pause flow.

## 1. Install dependencies and import the supplied list

Use the Node.js version required by `word-duel-server/package.json` (Node 22.5 or newer). From the workspace root, open a PowerShell terminal:

```powershell
cd word-duel-server
npm.cmd install
npm.cmd run import-finish-words -- --file clean-words.txt --check APPLE
```

The mode uses `better-sqlite3` and its own `word-duel-server/data/finish-word.sqlite` file. It does not change the existing Word Chain database. The `words` table has one column, `word TEXT PRIMARY KEY`; its primary-key index supports exact lookups through a prepared statement and bound parameter.

The server repository bundles an exact copy of the supplied `clean-words.txt`, containing 89,239 distinct alphabetic entries, so a server-only deployment includes its dictionary source. The original workspace-root file is untouched. The importer lowercases entries, skips blank lines, deduplicates words, and accepts both LF and CRLF files with an optional UTF-8 BOM. A single-character dictionary entry can exist in SQLite; the game's separate minimum-two-character rule still rejects it during play.

An unchanged source is not imported again. A SHA-256 fingerprint detects content changes. Replacing the dictionary is one SQLite transaction, so a malformed or empty file leaves the previous dictionary intact. SQLite contains exactly the current file's words after a successful replacement.

The server initializer also imports or updates the list on startup, so the explicit command is useful for checking the database before launching.

## 2. Start the backend and React client

In the backend terminal:

```powershell
npm.cmd start
```

Express and Socket.IO listen on port **3001** by default.

Open a second PowerShell terminal at the workspace root:

```powershell
cd word-duel
npm.cmd install
npm.cmd run dev
```

Open **http://localhost:5173**. The development client connects to **http://localhost:3001**. To use a different backend, set `VITE_SERVER_URL` in the client environment before starting Vite. For players on other devices, use a reachable backend URL and expose the Vite development server with `npm.cmd run dev -- --host 0.0.0.0`.

## 3. Create a match and play

1. Select **Finish the Word** in the game hub, enter your name, choose a capacity from 2 to 8, and create a room.
2. Other players enter their names and join with the room code. Separate browser tabs can be used to test multiple players locally.
3. Each player selects one of eight characters: Knight, Wizard, Ninja, Robot, Alien, Pirate, Astronaut, or Dino. A chosen character is locked for everyone else immediately. Choosing another character releases the previous one.
4. Once the room has 2–8 players, all connected and each with a unique character, the host starts the match.
5. The server chooses the starting letter. The active player has **10 seconds** and starts with **3 hearts**. Only that player's word input is active and automatically focused.
6. A submission must contain at least **2 letters**, exist in the imported SQLite dictionary after lowercase normalization, begin with the required prefix, and be unused in the current match. Validation is an exact whole-word lookup, not a prefix vocabulary search.
7. Accepted words set the next required prefix to their last letter: `APPLE → ELEPHANT → TURTLE`. After **10 accepted words**, hard mode requires the last **two** letters of the previous accepted word instead.
8. An invalid submission immediately costs **one heart and the turn**. A timeout also costs one heart and passes the turn. The previous accepted word/prefix remains in effect after a failed turn. A stale or out-of-turn network action returns an error without deducting a heart.
9. Players with zero hearts are eliminated and can watch. The last player with hearts remaining wins.

The stage uses eight distinct **2D SVG characters**. Floating nametags and heart counters identify each player. A smooth stage/camera transition focuses on the active character at each turn; reduced-motion preferences are respected. The active player's current typing appears publicly in a speech bubble, so other players can see the live word before submission.

## 4. Implementation map

Paths below are relative to the workspace root.

| File | Responsibility |
| --- | --- |
| `word-duel-server/scripts/importFinishWords.js` | Import/validation CLI and argument parsing. |
| `word-duel-server/src/services/FinishWordDictionary.js` | SQLite connection, single-column indexed vocabulary, transactional seeding, and prepared `isValidWord()` lookup. |
| `word-duel-server/src/services/FinishWordGame.js` | Turn rules, lives/elimination, used-word set, hard mode, typing ownership, and authoritative deadlines. |
| `word-duel-server/src/socket/FinishWordSocket.js` | Exclusive character locks, membership checks, room broadcasts, timeout scheduling, and pause/resume integration. |
| `word-duel-server/index.js` | Existing Express/Socket.IO server, room creation/joining, mode registration, session recovery, and disconnect votes. |
| `word-duel/src/hooks/useFinishWord.js` | React input/draft state, typing/submission actions, server-clock display, and turn synchronization. |
| `word-duel/src/components/FinishWord.jsx` | Character lobby, SVG stage, active-turn HUD/input, live bubbles, and results. |
| `word-duel/src/components/FinishWord.css` | Responsive character/stage layouts, focus transitions, and reduced-motion styling. |
| `word-duel/src/App.jsx` | Game-hub selection and routing to the new lobby/game/results screens. |

The game engine can be tested with an injected clock and validator. In production, the transport injects `dictionary.isValidWord()` and schedules each turn using the server's deadline. The React countdown is a display of that deadline, not the authority deciding whether a word arrived in time.

### Socket contract

Room codes are the room IDs. Room actions accept `code`; Finish the Word aliases also accept `roomId`. Use the newest server-issued `turnId` for typing and submission, so a delayed packet cannot change a later turn.

| Client event | Payload | Behavior |
| --- | --- | --- |
| `CREATE_ROOM` | `{ username, gameMode: "finish-word", maxPlayers }` | Creates a room through the existing hub flow. |
| `join_room` | `{ code, username }` or `{ roomId, name }` | Joins the existing room; `JOIN_ROOM` and `join-room` remain compatible. |
| `select_character` | `{ code, characterId }` | Claims an available character in the lobby; IDs are `knight`, `wizard`, `ninja`, `robot`, `alien`, `pirate`, `astronaut`, `dino`. |
| `start_game` | `{ code }` | Host-only start after all room members are connected and have selected unique characters. |
| `player_typing` | `{ code, turnId, text }` | Broadcasts the current active player's sanitized typing to the room. |
| `submit_word` | `{ code, turnId, word }` | Runs server validation and resolves the turn. |

Actions support acknowledgement callbacks. A transport/ownership/stale-turn failure responds with `{ success: false, message }`. A processed word can return `{ success: true, accepted: false, message }` when the word was invalid and the life penalty was applied.

| Server event | Content/purpose |
| --- | --- |
| `room-created`, `room-joined`, `player-joined` | Existing room/lobby snapshots and roster updates. |
| `character_selected` | Current roster, character ownership, and `availableCharacters`. |
| `turn_start` | Complete new-turn snapshot, including active player, `turnId`, required prefix, deadline, lives, and server time; drives stage focus. |
| `game_state` | Updated complete match snapshot without requiring a new turn. |
| `player_typing` | `{ code, gameId, turnId, playerId, text }` for the active player's speech bubble. |
| `word_accepted`, `word_rejected` | Turn outcome with player ID, word/reason/message, and elimination information. |
| `player_eliminated` | IDs of players removed from active play. |
| `game_over` | Final match snapshot with winner information. |

Clients render the server's state rather than assigning themselves a character, a successful word, extra time, or lives. The server checks room/socket membership and turn ownership before any rule mutation.

## 5. Sessions, disconnects, and persistence

The mode uses the existing `room-session` credentials, socket handshake, and `resume-room` flow. Returning connections are attached to their reserved player slot before room-capacity checks. Keep the session data private; the application manages it without displaying or logging tokens.

The waiting room shows reconnecting status beside names. During play, the room pauses when a player disconnects or backgrounds the browser. The existing pause dialog lists connection states and offers kick voting after **45 seconds** of reconnection. A majority of active players can remove an absent player; the game resumes when the remaining players are connected. Paused time does not consume the turn's remaining countdown.

Vocabulary persists in SQLite. **Rooms and active Finish the Word matches are held in server memory:** restarting the backend ends those active sessions, although the imported dictionary remains available for new matches.

## 6. Validate the implementation

From `word-duel-server`:

```powershell
npm.cmd run import-finish-words -- --check ELEPHANT
node --test test/finishWordDictionary.test.js test/finishWordGame.test.js test/finishWordSocket.test.js
npm.cmd test
```

From `word-duel`:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:finish-live
npx.cmd playwright test --project=chromium
```

Browser checks use the repository's Playwright configuration. If Chromium is not installed for Playwright, install it with `npx.cmd playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed compatible Chrome executable. The tests exercise the actual React components; backend tests separately exercise the game rules, character locks, deadline enforcement, and dictionary queries.

## Dictionary configuration and API reference

The default source lookup uses the bundled `word-duel-server/clean-words.txt`, followed by `../clean-words.txt` as a fallback. The bundled file is a byte-for-byte copy of the original supplied source; both have SHA-256 `3D7A032A567AB7F432B6F02B66EC301D6D0F763A6723A3CEFE3166BDFD924C93`. The original workspace-root file remains unchanged. A deployment of the server repository can seed itself without files outside that repository. Configure `FINISH_WORDS_FILE` to use a different source path.

```powershell
$env:FINISH_WORDS_FILE = 'C:\word-lists\clean-words.txt'
$env:FINISH_WORD_DB_PATH = 'C:\game-data\finish-word.sqlite'
npm.cmd start
```

Explicit options override the corresponding environment variables. Database directories are created automatically. A previously imported database can start without the default source file, allowing deployments to ship the prepared database instead. An explicitly configured missing source always fails with a clear error. A fresh database requires the actual supplied list; there is no alternate or placeholder dictionary.

CLI options:

```powershell
node scripts/importFinishWords.js --file clean-words.txt --db data/finish-word.sqlite --check elephant
node scripts/importFinishWords.js --force
node scripts/importFinishWords.js --help
```

### Dictionary API

```js
const { createFinishWordDictionary } = require('./src/services/FinishWordDictionary');
const dictionary = createFinishWordDictionary(); // Seed/update once at startup.

dictionary.isValidWord('ELEPHANT'); // true when present in clean-words.txt
dictionary.isValidWord('not-a-word'); // false
dictionary.count; // Number of indexed entries.

// Close on application shutdown when the server has finished using it.
dictionary.close();
```

The returned object also includes `databasePath`, `filePath`, `imported`, and `sourceSha256`. The initializer accepts `{ filePath, databasePath, force }`; `databasePath: ':memory:'` is supported for isolated tests.

The dictionary API intentionally handles vocabulary membership only. The server's game loop must also validate player identity, current turn/deadline, the required last-letter or last-two-letter prefix, minimum length, and words already used in the match.
