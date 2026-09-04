# Chesy

A local-first chess game review app. Load a PGN and Chesy walks every move
with a real Stockfish evaluation and a Chess.com-style classification:
Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss,
Blunder, with no account and no usage limits.

The analysis happens on your own machine. Stockfish is a real engine
process driven over UCI, not a throttled cloud endpoint, and your games are
never uploaded anywhere.

> Chesy's classification and explanation logic are documented
> approximations of Chess.com's Game Review, not a reverse-engineered copy
> of their proprietary, undocumented algorithm. The reasoning behind each
> class is written down in
> [`ml/specs/review_contract.md`](ml/specs/review_contract.md).

## Install on Android

[**Download the latest APK**](https://github.com/saqibsiddiq/chess.qurb/releases/latest)

arm64 only, which covers essentially any phone from the last eight years.
Android will ask permission to install from your browser or file manager,
which is expected for an app that does not come from the Play Store.

The download is about 9 MB. On first launch Chesy fetches the chess
engine's neural networks, 107 MB, once. Do that on Wi-Fi. Everything after
it works offline.

## When Chesy uses the network

Analysis is local, but the app is not hermetic, and it is worth being
precise about where it does reach out:

1. **The engine's neural networks**, once, on first launch. See
   [Packaging](#packaging) for why they are not in the download.
2. **Importing your games**, if you ask it to pull recent games from a
   Lichess or Chess.com username.
3. **Language packs**, if you pick a language other than English.

There is no telemetry, no account, and no request that carries a position
or a game off the device.

## What it does

- **Full-game review.** Every position is evaluated locally; each move gets
  a classification, a centipawn score, the engine's best line, and per-side
  accuracy.
- **Plain-English explanations.** Rule-based text explains what a move
  changed, with tactical motifs (fork, pin, skewer, back rank, hanging
  piece) highlighted on the board.
- **An optional small language model.** A ~100MB GGUF model, trained from
  scratch for this project, can be asked to explain a move in more depth.
  It is strictly opt-in per move, see [Small language model](#small-language-model).
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
- **Multilingual.** English ships in the app. Other languages are fetched
  once and then cached, so a language works offline like the rest of it.

## Interface

The app is built for desktop, tablet and phone as three distinct layouts
rather than one that reflows. The shell owns the viewport and does not
scroll. The board is measured from whatever space is left and always fits,
with only the move list scrolling internally.

On touch devices the board itself is the control: tap the left or right of
the board to step through the game, press and hold either side to jump to
the start or the end, and swipe horizontally to scrub. Arrow keys and `F`
(flip board) work throughout.

## Packaging

Stockfish's two NNUE networks are 107 MB of a 109 MB engine binary. Built
without them the engine is 1.3 MB, and given the networks at runtime
through the `EvalFile` and `EvalFileSmall` UCI options it searches
*identically*: `bench 16 1 12` returns 1,364,733 nodes either way, node for
node. That is what lets the Android package be about 9 MB rather than 116.

The networks are published as release assets and described by a manifest
the app fetches on launch, so a newer network can reach an installed app
without shipping an update. Every download is checked against a SHA-256 in
the manifest before it is installed, and nothing fetched is ever executed:
on Android the only directory the system will run code from is the one the
installer writes, so the engine binary and the Rust library can change only
through a new package.

## Running it

Requires [Stockfish](https://stockfishchess.org/download/) on your `$PATH`
for desktop development.

```bash
cd app
npm install
npm run tauri dev
```

`npm run dev` alone starts only the web frontend. The engine, saved
reviews, PGN scanning and the SLM are Tauri commands, so those features are
inert in a plain browser.

### Tests

```bash
cd app && npm test                     # frontend, 177 tests
cd app/src-tauri && cargo test --lib   # backend, 24 tests
```

## Building

### Desktop

```bash
cd app
npm run tauri build
```

The app looks for a bundled engine at `binaries/stockfish` and falls back
to `stockfish` on `$PATH`. See
[`app/src-tauri/binaries/README.md`](app/src-tauri/binaries/README.md).

### Android

The toolchain needs several environment variables, most of which fail in
ways that do not name what is missing, so they live in one script:

```bash
source scripts/android-env.sh
bash scripts/build-stockfish-android.sh      # engine, ~1.3MB, stub networks
cd app && npm run tauri android build -- --apk --target aarch64
```

`scripts/build-stockfish-android.sh` cross-compiles Stockfish for arm64.
Set `EMBED_NETS=1` to bake the networks in and skip the first-run download,
at the cost of a 116 MB package.

To sign release builds, run `scripts/setup-android-signing.sh`, which
patches the generated Gradle project and prints the `keytool` command for
creating a keystore. Credentials live in `app/src-tauri/keystore.properties`,
which is gitignored along with `*.jks`. Without that file the build still
succeeds and produces an unsigned APK.

`scripts/build-icons.sh` regenerates the launcher icons from the SVGs in
`app/icons-src/`.

## Small language model

`ml/` holds the full pipeline that produces the model: dataset
construction, tokenizer, training, and evaluation. The trained adapter is
converted to GGUF and embedded as a Tauri resource, then run in-process
through a native llama.cpp binding, with no sidecar and no subprocess.

It is deliberately opt-in per move. An earlier version generated
explanations automatically for every move and in the background for the
rest of the game, which put the model's worker in direct CPU contention
with Stockfish's search threads and caused real freezes. The
always-instant rule-based explanation is the default; the model is a
button.

## Website

The marketing site in [`website/`](website) is a static page with no build
step. Open `website/index.html`, or serve the directory:

```bash
python3 -m http.server 8090 --directory website
```

It is published to GitHub Pages by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push
to `main` that touches `website/`. The site also serves the asset manifest
and the language packs the app downloads.

## Repository layout

| Path | What's in it |
| --- | --- |
| `app/` | The Tauri application, React and TypeScript frontend, Rust backend |
| `app/src-tauri/` | Engine process, SLM runtime, local storage, PGN scanning |
| `scripts/` | Android toolchain setup, Stockfish cross-compile, signing, icons |
| `ml/` | Dataset, tokenizer, training and evaluation for the language model |
| `website/` | Static marketing site, asset manifest, language packs |
| `docs/` | Architecture notes, decision records, phase write-ups |
| `data/`, `dataset/` | Dataset construction and audit tooling |
| `tools/` | Benchmarking and comparison scripts |

## License

MIT for Chesy's own code, see [LICENSE](LICENSE).

Chesy ships two components under the GPL, which carry their own
obligations:

- **[Stockfish](https://github.com/official-stockfish/Stockfish)**, GPLv3,
  as a separate executable invoked over UCI rather than linked in. See
  [`app/src-tauri/binaries/README.md`](app/src-tauri/binaries/README.md).
- **cburnett** piece artwork, GPLv2 or later, from
  [Lichess](https://github.com/lichess-org/lila). A CC0 alternative is kept
  at `app/src/assets/chessground.rhosgfx.css`.
