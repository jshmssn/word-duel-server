# Word Chain dictionary source

Word Chain accepts words only from a local import of the English Speller Database
(ESDB, formerly SCOWL). The application intentionally has no AI-based validity
check and never sends submitted words to an external service.

Generate a curated American-English list from the official ESDB checkout:

```sh
./scowl --db scowl.db word-list 60 A 1 --deaccent --wo-poses=abbr --categories= > scowl-60-en-us.txt
```

This uses the vetted size-60 vocabulary, excludes abbreviations, and strips the
special categories that are unsuitable for a general word game. Put the result
in this directory, then run from `server/`:

```sh
npm run import-words
```

Or supply a different exported ESDB list explicitly:

```sh
npm run import-words -- --source=/absolute/path/to/word-list.txt
```

For the legacy SCOWL distribution, pass its `final/` directory instead. The
importer combines `english-words.10` through `english-words.60`, which is the
appropriate common-vocabulary range for this game.

The generated `word-chain.sqlite` database is local runtime data and is not a
source of truth. Regenerate it with the import command whenever the SCOWL list
changes.
