# Changelog

## v0.1.0 — first release

Chesy reviews a chess game locally: load a PGN, and it walks through
every move with a real Stockfish evaluation and a Chess.com-style
classification, on your own machine, with no account and no usage
limit.

### Review

- Full 10-class move classification — Brilliant, Great, Best,
  Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder — matching
  Chess.com's Game Review categories. Chesy's classifier is a
  documented approximation of Chess.com's own (proprietary) algorithm,
  not a reverse-engineered copy; see `ml/specs/review_contract.md` for
  the reasoning behind each class.
- Reviews classify moves incrementally as Stockfish reports each
  position, instead of blocking until the whole game finishes — you
  see moves light up in the move list and evaluation graph as the
  engine works through the game, not all at once at the end.
- A Fast/Deep toggle: Fast (depth 10, single line) favors speed on
  weaker hardware; Deep (depth 14, two lines) adds Great/Brilliant
  detection at roughly double the engine time per move.
- Per-move explanations point out hanging pieces, missed forks/pins/
  skewers, missed and allowed mate, discovered attacks, and back-rank
  weaknesses, with board arrows that show exactly one coherent,
  non-overlapping set of moves per position — not stacked/redundant
  arrows pointing at the same squares.
- An evaluation graph and accuracy score (per side) across the game.

### Interface

- Mobile-first layout: a single-column board → nav → engine panel →
  move list → graph flow on narrow screens, reflowing to two columns
  past 801px — not a shrunk-down copy of a desktop-only design.

### Packaging

- Stockfish now ships bundled inside the app (Linux) — no separate
  install required. See `app/src-tauri/binaries/README.md` if you're
  building from source.

### Known limitations

- Move explanations are currently rule-based templates, not the
  from-scratch small language model described as the project's
  long-term goal — that model hasn't been trained yet.
- Linux only for this release (`.deb`/`.rpm`). Windows/macOS and
  Android are not yet built.
- The bundled Stockfish binary is dynamically linked against the build
  machine's glibc; it may not run on distros with a substantially
  older glibc. A statically-linked build would fix this — see
  `app/src-tauri/binaries/README.md`.

### License

Chesy's own code is MIT-licensed. It bundles the Stockfish chess
engine (invoked as a separate process over UCI, not linked), which
remains under its own GNU GPLv3 license — see `LICENSE` and
`app/src-tauri/binaries/README.md`.
