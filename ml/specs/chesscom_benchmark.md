# Chess.com Benchmark Policy

## Purpose

This benchmark measures how closely Chesy's review logic matches actual
Chess.com Game Review output.

It is an evaluation dataset, not training data.

## Ground truth

Ground truth means the classification displayed by the full Chess.com
Game Review system.

Quick Analysis / Game Over classifications are not treated as equivalent
ground truth.

## Original labels

The original Chess.com classification must always be preserved verbatim.

Allowed values:

- Brilliant
- Great
- Best
- Excellent
- Good
- Book
- Inaccuracy
- Mistake
- Miss
- Blunder

## Comparison labels

A separate comparison label may be derived for analysis against Chesy's
six-class system.

Any mapping must include a mapping version.

The mapping must never replace the original Chess.com label.

## Development set

Used for:

- debugging
- format validation
- classifier analysis
- hypothesis generation

The development set may be inspected during implementation.

## Sealed test set

Used only for final evaluation.

It must not be used for:

- threshold tuning
- classifier tuning
- prompt tuning
- teacher prompt selection
- SLM model selection
- SLM training

## Review context

For every benchmark game, preserve available review context including:

- source artifact
- Chess.com Game Review
- classification version when available
- engine strength/settings when available
- player ratings

Chess.com states that different review strength settings can produce
different classifications.

## Evaluation

We report:

1. exact 10-class agreement where the Chess.com label is available;
2. six-class agreement using an explicit mapping;
3. confusion matrices;
4. per-class precision/recall/F1 where statistically meaningful;
5. systematic severity bias;
6. special-label detection for Brilliant, Great, Book, and Miss.

## Important limitation

Chess.com's Expected Points function and complete special-classification
implementation are proprietary.

A Chesy implementation that attempts to approximate them must be labeled
as a proxy and must never be described as the official Chess.com algorithm.
