# Chesy

A local-first chess game review app. Load a PGN and Chesy walks every move
with a real Stockfish evaluation and a Chess.com-style classification —
Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss,
Blunder — with no account, no server and no usage limits.

Everything runs on the machine in front of you. Stockfish is a real engine
process over UCI, not a throttled cloud endpoint, and there are no network
calls at runtime.

> Chesy's classification and explanation logic are documented
> approximations of Chess.com's Game Review, not a reverse-engineered copy
> of their proprietary, undocumented algorithm. The reasoning behind each
> class is written down in
> [`ml/specs/review_contract.md`](ml/specs/review_contract.md).

## What it does

- **Full-game review.** Every position is evaluated locally; each move gets
  a classification, a centipawn score, the engine's best line, and per-side
  accuracy.
- **Plain-English explanations.** Rule-based text explains what a move
  changed, with tactical motifs (fork, pin, skewer, back rank, hanging
  piece) highlighted on the board.
- **An optional small language model.** A ~100MB GGUF model, trained from
  scratch for this project, can be asked to explain a move in more depth.
  It is strictly opt-in per move — see [Small language model](#small-language-model).
- **Finds your PGNs for you.** Rather than opening a file browser, Chesy
  scans the directories a chess client or browser actually writes to and
  lists what it finds, with players, game count and date.
- **Import from Lichess or Chess.com.** Pull recent games by username.
- **Saved reviews.** Completed reviews are stored locally and reopen
  instantly without re-running the engine.
- **Cross-game insights.** Twenty reviews say more than one does; Chesy
  aggregates recurring weaknesses across your saved games.
- **Practice from a position.** Replay a moment you got wrong and have the
  engine judge your attempt.

## Interface

The app is built for desktop, tablet and phone as three distinct layouts
rather than one that reflows. The shell owns the viewport and does not
scroll — the board is measured from whatever space is left and always fits,
with only the move list scrolling internally.

On touch devices the board itself is the control: tap the left or right of
the board to step through the game, double tap either side to jump to the
start or the end, and swipe horizontally to scrub. Arrow keys and `F` (flip
board) work throughout.

## Running it

Requires [Stockfish](https://stockfishchess.org/download/) on your `$PATH`,
unless you are running a build with it bundled (see
[`app/src-tauri/binaries/README.md`](app/src-tauri/binaries/README.md)).

```bash
cd app
npm install
npm run tauri dev
```

`npm run dev` alone starts only the web frontend. The engine, saved reviews,
PGN scanning and the SLM are Tauri commands, so those features are inert in
a plain browser.

### Tests

```bash
cd app && npm test          # frontend
cd app/src-tauri && cargo test --lib   # backend
```

## Building a release

```bash
cd app
cp "$(which stockfish)" src-tauri/binaries/stockfish
chmod +x src-tauri/binaries/stockfish
npm run tauri build
```

To include the language model, place the GGUF where
[`app/src-tauri/models/README.md`](app/src-tauri/models/README.md) describes
before building. Both the engine binary and the weights are gitignored —
they are large, platform-specific and regenerable.

## Small language model

`ml/` holds the full pipeline that produces the model: dataset
construction, tokenizer, training, and evaluation. The trained adapter is
converted to GGUF and embedded as a Tauri resource, then run in-process
through a native llama.cpp binding — no sidecar, no subprocess.

It is deliberately opt-in per move. An earlier version generated
explanations automatically for every move and in the background for the
rest of the game, which put the model's worker in direct CPU contention
with Stockfish's search threads and caused real freezes. The always-instant
rule-based explanation is the default; the model is a button.

## Website

The marketing site in [`website/`](website) is a static page with no build
step — open `website/index.html`, or serve the directory:

```bash
python3 -m http.server 8090 --directory website
```

It is published to GitHub Pages by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push
to `main`.

## Repository layout

| Path | What's in it |
| --- | --- |
| `app/` | The Tauri application — React/TypeScript frontend, Rust backend |
| `app/src-tauri/` | Engine process, SLM runtime, local storage, PGN scanning |
| `ml/` | Dataset, tokenizer, training and evaluation for the language model |
| `website/` | Static marketing site |
| `docs/` | Architecture notes, decision records, phase write-ups |
| `data/`, `dataset/` | Dataset construction and audit tooling |

## Stack

Tauri (Rust) + React and TypeScript, Stockfish over UCI, llama.cpp for the
language model. No telemetry, no accounts, no runtime network calls.

## License

See [LICENSE](LICENSE). Chesy bundles
[Stockfish](https://github.com/official-stockfish/Stockfish), licensed under
the GNU GPLv3 — see
[`app/src-tauri/binaries/README.md`](app/src-tauri/binaries/README.md) for
its licensing and source.
