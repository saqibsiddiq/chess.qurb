# Chesy Classification Policy

## Purpose

States, per class, whether it is Chesy's own engine-driven logic, a
documented heuristic approximation, or not yet produced. This is the
canonical answer to "does Chesy's classifier equal Chess.com's?" — read
this before assuming any label means more than what's listed here.

## Status table

| Class | Status | Source |
|---|---|---|
| Best | canonical, with a dataset-only fallback | Chesy engine logic (played move == engine's top choice, or checkmate). In the dataset pipeline specifically, `best_move_uci` is only known for the ~30% of rows the extractor bothered to search (inaccuracy-tier or worse, under the old cost-gating) — for the other ~70%, a `loss_cp < 5` proxy stands in, since literal move-equality can't be checked without a best-move lookup. The live app always has a best move from the engine and never needs this fallback. |
| Excellent | canonical | Chesy engine logic (win%/cp-loss ladder) |
| Good | canonical | Chesy engine logic (win%/cp-loss ladder) |
| Inaccuracy | canonical | Chesy engine logic (win%/cp-loss ladder) |
| Mistake | canonical | Chesy engine logic (win%/cp-loss ladder) |
| Blunder | canonical | Chesy engine logic (win%/cp-loss ladder) |
| Book | approximation | opening-frequency heuristic mined from Chesy's own game corpus (`data/reference/opening_book.json`) — not a licensed theory database, and not Chess.com's book detection |
| Miss | approximation | contextual tactical heuristic: a mistake/blunder-tier move that specifically forfeited a missed forced mate, fork, pin, or skewer. Only detectable on rows where motif analysis actually ran — see the dataset-side limitation below |
| Great | deferred | requires a second engine line (MultiPV=2) on moves that already tie the engine's top choice, to detect "only good move in the position" |
| Brilliant | deferred | requires Great's data plus sacrifice detection (a piece-value table and board analysis of unrecaptured material) |

## What "canonical" means here

The six severity classes are Chesy's own computed logic (a win%-based
loss ladder), not a reproduction of Chess.com's proprietary Expected
Points model. "Canonical" means Chesy's live app and dataset pipeline
compute it the same way — not that it matches Chess.com's internal
formula. See [review_contract.md](review_contract.md) for the full
ground-truth/benchmark policy.

## What "approximation" means here

Book and Miss are Chesy's own heuristics, informed by public descriptions
of what these Chess.com labels mean, not a reproduction of Chess.com's
actual detection logic (which is proprietary and, per
[review_contract.md](review_contract.md) section 9, not assumed
reproducible from public documentation).

**Book**: a move is flagged if it recurs across many distinct real games
in Chesy's own corpus within the opening phase. Frequent-in-our-corpus is
not the same claim as "Chess.com would call this Book" — it's a proxy.

**Miss**: only mistake/blunder-tier moves that also match a specific
missed-tactic motif (forced mate, fork, pin, or skewer available via the
engine's best move) get relabeled Miss. In the dataset pipeline
specifically (not the live app), this detection depends on motif analysis
having actually run for that row, which historically was gated to
inaccuracy/mistake/blunder-tier moves under the *old* classification
formula. A row that crosses into mistake/blunder under the *new*
win%-based formula but wasn't analyzed under the old one will have no
motif data and cannot be upgraded to Miss — this under-detects Miss
rather than over-detects it. The live app (`reviewEngine.ts`) does not
have this limitation since it always computes motifs before classifying.

## What "deferred" means here

Great and Brilliant are not bugs or oversights — they require data this
pipeline does not currently compute for most of the corpus (a second
engine line on moves that already found the top choice). Producing them
would mean a substantially larger Stockfish re-run across the ~70% of
rows that currently get no engine analysis at all. That's tracked as
separate future work, not silently skipped.

## Scope note

This policy governs `dataset/src/extractor.py`, `dataset/src/classify.py`,
and everything downstream in the training data pipeline. The live app
(`app/src/lib/reviewEngine.ts`) already implements all 10 classes,
including Great/Brilliant — this document is specifically about what the
*dataset* produces, which currently lags the live app by design.
