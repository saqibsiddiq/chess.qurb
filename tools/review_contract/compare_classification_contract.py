#!/usr/bin/env python3
"""Audit that a corpus's stored `classification` field matches
dataset/src/classify.py — the single canonical Python classifier.

Historically this script compared TWO independently hand-maintained
Python mirrors (one of dataset/src/extractor.py, one of
app/src/lib/reviewEngine.ts) against each other and against the stored
label. That's what let them drift apart. Now that both the real
extractor and this audit script import the same dataset/src/classify.py,
there is only one thing left to check: does the stored corpus actually
match the formula, i.e. was it correctly (re)generated. See
ml/specs/classification_policy.md for what "matches" means per class.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "dataset" / "src"))
import classify  # noqa: E402

# Classes classify.py can actually produce from stored corpus fields.
# Great/Brilliant are intentionally excluded — see
# ml/specs/classification_policy.md.
EVALUABLE_CLASSES = (
    "best",
    "excellent",
    "good",
    "book",
    "inaccuracy",
    "mistake",
    "miss",
    "blunder",
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/clean/corpus_unique.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/audit/classification_contract_diff.json"))
    ap.add_argument("--sample", type=int, default=0, help="Check only the first N rows; 0 means all rows.")
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Input not found: {args.input}")
    if args.sample < 0:
        raise SystemExit("--sample cannot be negative")

    args.output.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    checkmates = 0
    missing_best = 0
    counts: Counter[str] = Counter()

    with args.input.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            if args.sample and total >= args.sample:
                break

            row = json.loads(line)
            stored_label = row["classification"]

            try:
                result = classify.classify_row(row)
            except Exception as exc:
                raise SystemExit(
                    f"Could not reclassify row at line {line_no}: {exc}; game={row.get('game_id')}"
                ) from exc

            computed_label = result.classification
            is_checkmate = result.is_checkmate

            if stored_label != computed_label:
                raise SystemExit(
                    "Stored classification does not match dataset/src/classify.py "
                    f"at line {line_no}: stored={stored_label}, computed={computed_label}, "
                    f"is_checkmate={is_checkmate}, game={row.get('game_id')}. "
                    "The corpus likely needs tools/dataset/reclassify.py re-run and promoted."
                )

            if is_checkmate:
                checkmates += 1
            if row.get("best_move_uci") is None:
                missing_best += 1

            counts[stored_label] += 1
            total += 1

            if total % 250_000 == 0:
                print(f"Rows checked: {total:,} (all self-consistent so far)", flush=True)

    report = {
        "version": 3,
        "input": str(args.input.resolve()),
        "classifier_source": "dataset/src/classify.py",
        "rows_checked": total,
        "checkmate_rows": checkmates,
        "missing_best_move_rows": missing_best,
        "mismatches": 0,
        "classification_counts": dict(counts),
        "classes_not_evaluable": ["great", "brilliant"],
        "classes_not_evaluable_reason": (
            "require a second engine line (MultiPV) that this corpus does not "
            "store for most rows — see ml/specs/classification_policy.md"
        ),
    }

    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== CLASSIFICATION CONTRACT CHECK ===")
    print(f"Rows checked:       {total:,}")
    print("Mismatches:         0 (any mismatch aborts immediately, see above)")
    print(f"Checkmate rows:     {checkmates:,}")
    print(f"Missing best move:  {missing_best:,}")
    print("\nStored label distribution:")
    for label in EVALUABLE_CLASSES:
        print(f"  {label:11s} {counts[label]:,}")
    print("\nNot evaluable from stored data: great, brilliant (see report)")
    print(f"\nReport: {args.output}")


if __name__ == "__main__":
    main()
