#!/usr/bin/env python3
"""Final training-corpus audit for Chesy Phase 5 JSONL shards."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "dataset" / "src"))
import classify  # noqa: E402

REQUIRED = {
    "game_id", "fen", "move_number", "color", "played_san", "played_uci",
    "eval_before_cp", "eval_after_cp", "eval_before_mate", "eval_after_mate",
    "loss_cp", "classification", "best_move_san", "best_move_uci",
    "motif", "motif_detail", "explanation",
}
# Great/Brilliant are intentionally absent — dataset/src/extractor.py
# doesn't produce them yet, see ml/specs/classification_policy.md.
VALID_CLASSES = {"best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder"}
VALID_COLORS = {"white", "black"}
BAD_CLASSES = {"inaccuracy", "mistake", "miss", "blunder"}


def add_example(examples: list[dict[str, Any]], item: dict[str, Any], limit: int = 20) -> None:
    if len(examples) < limit:
        examples.append(item)


def audit_file(path: Path, report: dict[str, Any]) -> None:
    worker = path.stem
    fr: dict[str, Any] = {
        "worker": worker,
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "rows": 0,
        "unique_games": 0,
        "invalid_json": 0,
        "missing_required_fields": 0,
        "bad_field_types": 0,
        "unknown_classifications": 0,
        "classification_mismatches": 0,
        "negative_loss": 0,
        "nonfinite_loss": 0,
        "negative_move_numbers": 0,
        "invalid_colors": 0,
        "blank_explanations": 0,
        "bad_motif_detail": 0,
        "duplicate_rows": 0,
        "duplicate_game_ids_within_file": 0,
        "game_ids": set(),
        "classifications": Counter(),
        "motifs": Counter(),
        "row_counts_by_game": Counter(),
        "first_move_by_game": {},
        "last_move_by_game": {},
    }

    seen_rows: set[tuple[str, int, str, str]] = set()
    game_row_counts: Counter[str] = Counter()
    game_last_move: dict[str, int] = {}
    game_first_move: dict[str, int] = {}

    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue

            fr["rows"] += 1

            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                fr["invalid_json"] += 1
                add_example(report["examples"]["invalid_json"], {
                    "file": worker, "line": line_no, "error": str(exc)
                })
                continue

            missing = REQUIRED - row.keys()
            if missing:
                fr["missing_required_fields"] += 1
                add_example(report["examples"]["missing_fields"], {
                    "file": worker, "line": line_no, "missing": sorted(missing)
                })
                continue

            type_ok = (
                isinstance(row["game_id"], str)
                and isinstance(row["move_number"], int)
                and not isinstance(row["move_number"], bool)
                and isinstance(row["color"], str)
                and isinstance(row["played_san"], str)
                and isinstance(row["played_uci"], str)
                and isinstance(row["classification"], str)
                and isinstance(row["motif"], str)
                and isinstance(row["motif_detail"], dict)
                and isinstance(row["explanation"], str)
            )
            if not type_ok:
                fr["bad_field_types"] += 1
                add_example(report["examples"]["bad_types"], {
                    "file": worker, "line": line_no
                })
                continue

            game_id = row["game_id"]
            if game_id in fr["game_ids"]:
                # We expect multiple rows per game, so this is not an error.
                pass
            else:
                fr["game_ids"].add(game_id)
                game_first_move[game_id] = row["move_number"]

            game_row_counts[game_id] += 1
            previous_last = game_last_move.get(game_id)
            game_last_move[game_id] = row["move_number"]

            cls = row["classification"]
            motif = row["motif"]
            fr["classifications"][cls] += 1
            fr["motifs"][motif] += 1
            report["classifications"][cls] += 1
            report["motifs"][motif] += 1

            if cls not in VALID_CLASSES:
                fr["unknown_classifications"] += 1

            loss = row["loss_cp"]
            if isinstance(loss, (int, float)) and not isinstance(loss, bool):
                if not math.isfinite(float(loss)):
                    fr["nonfinite_loss"] += 1
                elif loss < 0:
                    fr["negative_loss"] += 1

                if cls in VALID_CLASSES and math.isfinite(float(loss)):
                    # classify_row() reconstructs the actual board and
                    # checks is_checkmate() directly, so unlike the old
                    # cp-loss-only mirror this no longer needs a
                    # motif == "mate" exemption for checkmate rows.
                    expected = classify.classify_row(row).classification
                    if expected != cls:
                        fr["classification_mismatches"] += 1
                        add_example(report["examples"]["classification_mismatches"], {
                            "file": worker,
                            "line": line_no,
                            "game_id": game_id,
                            "move_number": row["move_number"],
                            "stored": cls,
                            "expected": expected,
                            "loss_cp": loss,
                            "played_uci": row["played_uci"],
                            "best_move_uci": row["best_move_uci"],
                            "motif": motif,
                        })
            else:
                fr["bad_field_types"] += 1

            if row["move_number"] < 1:
                fr["negative_move_numbers"] += 1

            if row["color"] not in VALID_COLORS:
                fr["invalid_colors"] += 1

            if not row["explanation"].strip():
                fr["blank_explanations"] += 1

            if not isinstance(row["motif_detail"], dict):
                fr["bad_motif_detail"] += 1

            key = (game_id, row["move_number"], row["color"], row["played_uci"])
            if key in seen_rows:
                fr["duplicate_rows"] += 1
                add_example(report["examples"]["duplicate_rows"], {
                    "file": worker, "line": line_no, "key": list(key)
                })
            else:
                seen_rows.add(key)

            if previous_last is not None and row["move_number"] < previous_last:
                add_example(report["examples"]["move_order_regressions"], {
                    "file": worker, "line": line_no, "game_id": game_id,
                    "previous_move": previous_last, "current_move": row["move_number"],
                })

    fr["unique_games"] = len(fr["game_ids"])
    fr["row_counts_by_game"] = {
        "min": min(game_row_counts.values()) if game_row_counts else 0,
        "max": max(game_row_counts.values()) if game_row_counts else 0,
        "mean": round(sum(game_row_counts.values()) / len(game_row_counts), 3)
        if game_row_counts else 0,
        "games_with_1_to_4_rows": sum(1 for n in game_row_counts.values() if n <= 4),
        "games_with_over_200_rows": sum(1 for n in game_row_counts.values() if n > 200),
        "games_with_over_300_rows": sum(1 for n in game_row_counts.values() if n > 300),
    }
    fr["classifications"] = dict(sorted(fr["classifications"].items()))
    fr["motifs"] = dict(sorted(fr["motifs"].items()))

    report["_worker_game_ids"][worker] = fr["game_ids"]

    for k in (
        "rows", "invalid_json", "missing_required_fields", "bad_field_types",
        "unknown_classifications", "classification_mismatches", "negative_loss",
        "nonfinite_loss", "negative_move_numbers", "invalid_colors",
        "blank_explanations", "bad_motif_detail", "duplicate_rows",
    ):
        report[k] += fr[k]

    report["game_count_sum"] += fr["unique_games"]
    report["files"].append(fr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--output", type=Path, default=Path("data/audit/final_audit.json"))
    args = ap.parse_args()

    files = sorted(args.input_dir.glob("worker_*.jsonl"))
    if not files:
        raise SystemExit(f"No worker_*.jsonl files found in {args.input_dir}")

    args.output.parent.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "version": 2,
        "files_found": len(files),
        "files": [],
        "rows": 0,
        "game_count_sum": 0,
        "unique_games_across_all_workers": 0,
        "cross_worker_duplicate_game_ids": 0,
        "invalid_json": 0,
        "missing_required_fields": 0,
        "bad_field_types": 0,
        "unknown_classifications": 0,
        "classification_mismatches": 0,
        "negative_loss": 0,
        "nonfinite_loss": 0,
        "negative_move_numbers": 0,
        "invalid_colors": 0,
        "blank_explanations": 0,
        "bad_motif_detail": 0,
        "duplicate_rows": 0,
        "cross_worker_duplicate_examples": [],
        "examples": {
            "invalid_json": [],
            "missing_fields": [],
            "bad_types": [],
            "classification_mismatches": [],
            "duplicate_rows": [],
            "move_order_regressions": [],
        },
        "classifications": Counter(),
        "motifs": Counter(),
        "_worker_game_ids": {},
    }

    print(f"Auditing {len(files)} worker files...", flush=True)
    for i, path in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {path.name}", flush=True)
        audit_file(path, report)

    workers = list(report["_worker_game_ids"])
    owner: dict[str, str] = {}
    for worker in workers:
        for game_id in report["_worker_game_ids"][worker]:
            if game_id in owner:
                report["cross_worker_duplicate_game_ids"] += 1
                add_example(report["cross_worker_duplicate_examples"], {
                    "game_id": game_id,
                    "first_worker": owner[game_id],
                    "second_worker": worker,
                })
            else:
                owner[game_id] = worker

    report["unique_games_across_all_workers"] = len(owner)

    # Keep the report JSON compact. Sets are for internal checking only.
    for fr in report["files"]:
        fr.pop("game_ids", None)
    report.pop("_worker_game_ids", None)

    report["classifications"] = dict(sorted(report["classifications"].items()))
    report["motifs"] = dict(sorted(report["motifs"].items()))

    args.output.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\n=== FINAL AUDIT ===")
    print(f"Files:                         {report['files_found']}")
    print(f"Rows:                          {report['rows']:,}")
    print(f"Sum of worker game counts:     {report['game_count_sum']:,}")
    print(f"Unique games across workers:   {report['unique_games_across_all_workers']:,}")
    print(f"Cross-worker duplicate games:  {report['cross_worker_duplicate_game_ids']:,}")
    print(f"Invalid JSON:                  {report['invalid_json']:,}")
    print(f"Missing required fields:       {report['missing_required_fields']:,}")
    print(f"Bad field types:               {report['bad_field_types']:,}")
    print(f"Unknown classifications:       {report['unknown_classifications']:,}")
    print(f"Classification mismatches:     {report['classification_mismatches']:,}")
    print(f"Negative loss:                 {report['negative_loss']:,}")
    print(f"Non-finite loss:               {report['nonfinite_loss']:,}")
    print(f"Invalid colors:                {report['invalid_colors']:,}")
    print(f"Blank explanations:            {report['blank_explanations']:,}")
    print(f"Duplicate rows:                {report['duplicate_rows']:,}")
    print(f"Cross-worker duplicates:       {report['cross_worker_duplicate_game_ids']:,}")

    print("\nClassifications:")
    print(json.dumps(report["classifications"], indent=2))

    print("\nMotifs:")
    print(json.dumps(report["motifs"], indent=2))

    print("\nPer-worker game-length flags:")
    for fr in report["files"]:
        print(
            f"  {fr['worker']}: "
            f"min={fr['row_counts_by_game']['min']} "
            f"max={fr['row_counts_by_game']['max']} "
            f"mean={fr['row_counts_by_game']['mean']} "
            f"1-4 rows={fr['row_counts_by_game']['games_with_1_to_4_rows']} "
            f">200={fr['row_counts_by_game']['games_with_over_200_rows']} "
            f">300={fr['row_counts_by_game']['games_with_over_300_rows']}"
        )

    print(f"\nReport: {args.output}")


if __name__ == "__main__":
    main()
