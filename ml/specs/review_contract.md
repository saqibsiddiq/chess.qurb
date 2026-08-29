# Chesy Review Contract

## Purpose

This document defines the canonical semantics used by Chesy's dataset
generation, live review engine, evaluation tooling, and future SLM.

No implementation may silently redefine these semantics.

## 1. External reference: Chess.com

Chess.com Game Review currently uses the following move classifications:

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

Chess.com Classification V2 uses an Expected Points Model for its primary
severity classifications. Expected Points depend on player rating and engine
evaluation.

Brilliant, Great, Book, and Miss are special classifications with additional
rules beyond the primary Expected Points thresholds.

## 2. Ground truth policy

When Chess.com Game Review is used as external ground truth:

- Preserve the original Chess.com label exactly.
- Store it as `chesscom_label`.
- Never overwrite it with a Chesy label.
- Never silently collapse labels.
- Any mapping into a Chesy-compatible classification must be explicit,
  versioned, and reversible.

## 3. Chesy classification

Chesy currently exposes six primary classifications:

- best
- excellent
- good
- inaccuracy
- mistake
- blunder

These are the internal labels used by the current dataset and application.

## 4. Comparison labels

When comparing Chesy against Chess.com, a separate
`comparison_label` may be created.

The mapping must record:

- mapping version
- source label
- destination label
- reason for mapping

The mapping must never replace the original `chesscom_label`.

## 5. Special Chess.com labels

The benchmark must retain separate evaluation for:

- Brilliant
- Great
- Book
- Miss

These labels must not be treated as ordinary severity classes.

## 6. Dataset semantics

The dataset stores:

- evaluation before
- evaluation after
- mate information
- loss in centipawns
- played move
- best move
- classification
- motif
- motif detail

The dataset classifier and application classifier must be independently
audited against this contract.

## 7. Training/serving consistency

The final SLM input contract must use the same structured semantic fields
defined here.

Classification and motif facts remain deterministic unless a later
contract explicitly changes this.

## 8. Evaluation policy

Development benchmarks may be used for implementation or prompt iteration.

The final benchmark must remain sealed and must not be used for:

- prompt tuning
- classifier threshold tuning
- teacher prompt selection
- model selection
- model training

## 9. Important limitation

Chess.com's proprietary Expected Points function and complete special-move
implementation are not assumed to be reproducible from public documentation.

Any Chesy approximation must be explicitly named as an approximation.
