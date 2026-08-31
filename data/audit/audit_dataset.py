#!/usr/bin/env python3
"""Streaming audit for Chesy Phase 5 JSONL shards."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REQUIRED = {
    "game_id", "fen", "move_number", "color", "played_san", "played_uci",
    "eval_before_cp", "eval_after_cp", "eval_before_mate", "eval_after_mate",
    "loss_cp", "classification", "best_move_san", "best_move_uci",
    "motif", "motif_detail", "explanation",
}
# Great/Brilliant are intentionally absent — dataset/src/extractor.py
# doesn't produce them yet, see ml/specs/classification_policy.md.
CLASSIFICATIONS = {"best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder"}


def audit_file(path: Path, report: dict[str, Any]) -> None:
    fr: dict[str, Any] = {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "rows": 0,
        "unique_games": 0,
        "invalid_json": 0,
        "missing_required_fields": 0,
        "bad_field_types": 0,
        "unknown_classifications": 0,
        "negative_loss": 0,
        "nonfinite_loss": 0,
        "negative_move_numbers": 0,
        "invalid_colors": 0,
        "blank_explanations": 0,
        "duplicate_rows": 0,
        "classifications": Counter(),
        "motifs": Counter(),
        "row_counts_by_game": {},
    }
    games: set[str] = set()
    seen: set[tuple[str, int, str, str]] = set()
    game_rows: Counter[str] = Counter()

    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            fr["rows"] += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                fr["invalid_json"] += 1
                report["examples"]["invalid_json"].append({"file": path.name, "line": line_no})
                continue

            missing = REQUIRED - row.keys()
            if missing:
                fr["missing_required_fields"] += 1
                if len(report["examples"]["missing_fields"]) < 20:
                    report["examples"]["missing_fields"].append(
                        {"file": path.name, "line": line_no, "missing": sorted(missing)}
                    )
                continue

            type_ok = (
                isinstance(row["game_id"], str)
                and isinstance(row["move_number"], int)
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
                if len(report["examples"]["bad_types"]) < 20:
                    report["examples"]["bad_types"].append({"file": path.name, "line": line_no})
                continue

            game_id = row["game_id"]
            games.add(game_id)
            game_rows[game_id] += 1

            cls = row["classification"]
            motif = row["motif"]
            fr["classifications"][cls] += 1
            fr["motifs"][motif] += 1
            report["classifications"][cls] += 1
            report["motifs"][motif] += 1

            if cls not in CLASSIFICATIONS:
                fr["unknown_classifications"] += 1

            loss = row["loss_cp"]
            if isinstance(loss, (int, float)):
                if not math.isfinite(float(loss)):
                    fr["nonfinite_loss"] += 1
                elif loss < 0:
                    fr["negative_loss"] += 1
            else:
                fr["bad_field_types"] += 1

            if row["move_number"] < 1:
                fr["negative_move_numbers"] += 1
            if row["color"] not in {"white", "black"}:
                fr["invalid_colors"] += 1
            if not row["explanation"].strip():
                fr["blank_explanations"] += 1

            key = (game_id, row["move_number"], row["color"], row["played_uci"])
            if key in seen:
                fr["duplicate_rows"] += 1
                if len(report["examples"]["duplicate_rows"]) < 20:
                    report["examples"]["duplicate_rows"].append(
                        {"file": path.name, "line": line_no, "key": list(key)}
                    )
            else:
                seen.add(key)

    fr["unique_games"] = len(games)
    if game_rows:
        fr["row_counts_by_game"] = {
            "min": min(game_rows.values()),
            "max": max(game_rows.values()),
            "mean": round(sum(game_rows.values()) / len(game_rows), 3),
        }
    for k in ("classifications", "motifs"):
        fr[k] = dict(sorted(fr[k].items()))

    report["files"].append(fr)
    for k in (
        "rows", "invalid_json", "missing_required_fields", "bad_field_types",
        "unknown_classifications", "negative_loss", "nonfinite_loss",
        "negative_move_numbers", "invalid_colors", "blank_explanations", "duplicate_rows",
    ):
        report[k] += fr[k]
    report["game_count_sum"] += fr["unique_games"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--output", type=Path, default=Path("data/audit/phase5_audit.json"))
    args = ap.parse_args()

    files = sorted(args.input_dir.glob("worker_*.jsonl"))
    if not files:
        raise SystemExit(f"No worker_*.jsonl files found in {args.input_dir}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "version": 1,
        "files_found": len(files),
        "files": [],
        "rows": 0,
        "game_count_sum": 0,
        "invalid_json": 0,
        "missing_required_fields": 0,
        "bad_field_types": 0,
        "unknown_classifications": 0,
        "negative_loss": 0,
        "nonfinite_loss": 0,
        "negative_move_numbers": 0,
        "invalid_colors": 0,
        "blank_explanations": 0,
        "duplicate_rows": 0,
        "classifications": Counter(),
        "motifs": Counter(),
        "examples": {
            "invalid_json": [],
            "missing_fields": [],
            "bad_types": [],
            "duplicate_rows": [],
        },
    }

    for i, path in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {path.name}", flush=True)
        audit_file(path, report)

    report["classifications"] = dict(sorted(report["classifications"].items()))
    report["motifs"] = dict(sorted(report["motifs"].items()))
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== AUDIT SUMMARY ===")
    print(f"Files:              {report['files_found']}")
    print(f"Rows:               {report['rows']:,}")
    print(f"Game-count sum:     {report['game_count_sum']:,}")
    print(f"Invalid JSON:       {report['invalid_json']:,}")
    print(f"Missing fields:     {report['missing_required_fields']:,}")
    print(f"Bad field types:    {report['bad_field_types']:,}")
    print(f"Unknown classes:    {report['unknown_classifications']:,}")
    print(f"Negative loss:      {report['negative_loss']:,}")
    print(f"Nonfinite loss:     {report['nonfinite_loss']:,}")
    print(f"Invalid colors:     {report['invalid_colors']:,}")
    print(f"Blank explanations: {report['blank_explanations']:,}")
    print(f"Duplicate rows:     {report['duplicate_rows']:,}")
    print("\nClassifications:")
    print(json.dumps(report["classifications"], indent=2))
    print("\nMotifs:")
    print(json.dumps(report["motifs"], indent=2))
    print(f"\nReport: {args.output}")


if __name__ == "__main__":
    main()
