#!/usr/bin/env python3
"""Cheaply relabel an existing dataset corpus with dataset/src/classify.py.

Recomputes `classification` and `explanation` for every row using fields
already stored in the row (eval_before/after cp+mate, played/best UCI,
fen, motif) — no PGN reparsing, no Stockfish. This exists because the
formula in dataset/src/extractor.py drifted from the live app's
classifier (app/src/lib/reviewEngine.ts); once extractor.py is fixed to
match (see dataset/src/classify.py), the *existing* 3.36M-row corpus
still carries labels from the old formula until this script re-applies
the new one.

Writes to a separate output file — never overwrites the input. Promote
the result to the live corpus filename yourself, once the printed
distribution report and downstream audit scripts look right (see
ml/specs/classification_policy.md and the plan this was built from).

Known limitation, inherited from the corpus itself: `motif` (needed to
detect Miss) is only populated for rows that needed engine analysis under
the *old* classification formula's gate. A row whose severity crosses a
boundary under the new formula but wasn't gated for engine analysis under
the old one will have motif="none" and can't be upgraded to Miss. This
under-detects Miss, never over-detects it.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "dataset" / "src"))
import classify  # noqa: E402
from templates import build_explanation  # noqa: E402


def reclassify_row(row: dict) -> dict:
    result = classify.classify_row(row)

    is_white = row["color"] == "white"
    move_number = row.get("move_number", 0)
    variant = (move_number + (0 if is_white else 1)) % 3

    new_explanation = build_explanation(
        result.classification,
        row.get("motif", "none"),
        row.get("motif_detail", {}),
        row["played_san"],
        row.get("best_move_san"),
        result.loss_cp,
        variant=variant,
    )

    updated = dict(row)
    updated["loss_cp"] = result.loss_cp
    updated["classification"] = result.classification
    updated["explanation"] = new_explanation
    return updated


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/clean/corpus_unique.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/clean/corpus_unique_v2.jsonl"))
    ap.add_argument(
        "--manifest",
        type=Path,
        default=Path("data/clean/reclassification_manifest_v2.json"),
    )
    args = ap.parse_args()

    before_counts: Counter[str] = Counter()
    after_counts: Counter[str] = Counter()
    transitions: Counter[str] = Counter()

    rows_seen = 0
    args.output.parent.mkdir(parents=True, exist_ok=True)

    print(f"Reclassifying {args.input} -> {args.output}", flush=True)
    with args.input.open("r", encoding="utf-8") as f_in, args.output.open("w", encoding="utf-8") as f_out:
        for line in f_in:
            if not line.strip():
                continue
            row = json.loads(line)
            old_classification = row.get("classification", "unknown")

            updated = reclassify_row(row)

            before_counts[old_classification] += 1
            after_counts[updated["classification"]] += 1
            transitions[f"{old_classification}->{updated['classification']}"] += 1

            f_out.write(json.dumps(updated, ensure_ascii=False, separators=(",", ":")))
            f_out.write("\n")

            rows_seen += 1
            if rows_seen % 250_000 == 0:
                print(f"  ...{rows_seen:,} rows reclassified", flush=True)

    changed = sum(count for key, count in transitions.items() if key.split("->")[0] != key.split("->")[1])

    manifest = {
        "input": str(args.input.resolve()),
        "output": str(args.output.resolve()),
        "rows_processed": rows_seen,
        "rows_changed_classification": changed,
        "classification_counts_before": dict(before_counts),
        "classification_counts_after": dict(after_counts),
        "transitions": dict(transitions.most_common()),
    }
    args.manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== RECLASSIFICATION COMPLETE ===")
    print(f"Rows processed:   {rows_seen:,}")
    print(f"Rows changed:     {changed:,} ({changed / rows_seen * 100:.1f}%)")
    print("\nBefore:")
    for cls, count in before_counts.most_common():
        print(f"  {cls:<12} {count:,}")
    print("\nAfter:")
    for cls, count in after_counts.most_common():
        print(f"  {cls:<12} {count:,}")
    print(f"\nManifest: {args.manifest}")
    print(f"Output:   {args.output}")
    print("\nThis wrote a NEW file — corpus_unique.jsonl is untouched. Validate,")
    print("then promote it yourself (see ml/specs/classification_policy.md).")


if __name__ == "__main__":
    main()
