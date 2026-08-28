# Chess.com Ground Truth

This directory stores external Chess.com Game Review data used to evaluate
Chesy's classification rules.

## Purpose

The benchmark answers:

> Which Chesy classification implementation is closer to actual
> Chess.com Game Review classifications?

This is an evaluation dataset only. It must never be used as SFT training
data.

## Source

Ground truth must come from the full Chess.com Game Review system.

Chess.com's current Classification V2 uses an Expected Points Model that
takes player rating and engine evaluation into account.

Quick Analysis results are not considered equivalent ground truth because
Chess.com states that full Game Review may revise classifications after
deeper server-side analysis.

## Raw data

`raw/` contains the original externally obtained review artifacts.

Raw files must never be modified in place.

## Normalized data

`normalized/` contains a lossless normalized representation used by the
benchmarking tools.

The normalized representation must preserve:

- Chess.com game identifier, when available
- player ratings
- color
- move number
- position/FEN, when available
- played move
- Chess.com classification
- best move, when available
- engine/review settings, when available
- source artifact identifier

## Label policy

Never silently collapse Chess.com labels.

The original label must always be preserved as `chesscom_label`.

Any six-class mapping used for comparison must be stored separately as
`comparison_label`, together with the mapping version.

## Benchmark rules

Ground-truth examples used for final evaluation must not be used during
prompt tuning, classifier tuning, or model selection.

The final sealed benchmark must be created from a separate held-out set.
