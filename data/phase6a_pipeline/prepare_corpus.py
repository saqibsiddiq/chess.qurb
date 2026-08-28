#!/usr/bin/env python3
"""
Phase 6: prepare the cleaned Chesy corpus for teacher generation / SLM work.

Design:
- Streams corpus_unique.jsonl one game at a time.
- Never loads the full 3M+ row corpus into RAM.
- Splits by game_id, not row.
- Keeps every error/motif row; samples normal rows.
- Writes train/validation/test and a teacher queue.
- Does NOT use template explanations as SFT targets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter
from pathlib import Path
from typing import Any, TextIO

BAD_CLASSES = {"inaccuracy", "mistake", "blunder"}
VALID_CLASSES = {"best", "excellent", "good", "inaccuracy", "mistake", "blunder"}


def split_for_game(game_id: str, seed: int) -> str:
    digest = hashlib.sha256(f"{seed}:{game_id}".encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], "big") / 2**64
    if value < 0.90:
        return "train"
    if value < 0.95:
        return "validation"
    return "test"


def make_input(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "fen": row["fen"],
        "played_move": row["played_san"],
        "played_uci": row["played_uci"],
        "best_move": row["best_move_san"],
        "best_move_uci": row["best_move_uci"],
        "eval_before_cp": row["eval_before_cp"],
        "eval_after_cp": row["eval_after_cp"],
        "eval_before_mate": row["eval_before_mate"],
        "eval_after_mate": row["eval_after_mate"],
        "loss_cp": row["loss_cp"],
        "classification": row["classification"],
        "motif": row["motif"],
        "motif_detail": row["motif_detail"],
        "color": row["color"],
        "move_number": row["move_number"],
    }


def make_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"{row['game_id']}:{row['move_number']}:{row['color']}:{row['played_uci']}",
        "game_id": row["game_id"],
        "input": make_input(row),
        "baseline_explanation": row["explanation"],
    }


def teacher_prompt(record: dict[str, Any]) -> str:
    x = record["input"]
    before = (
        x["eval_before_cp"]
        if x["eval_before_cp"] is not None
        else f"mate {x['eval_before_mate']}"
        if x["eval_before_mate"] is not None
        else None
    )
    after = (
        x["eval_after_cp"]
        if x["eval_after_cp"] is not None
        else f"mate {x['eval_after_mate']}"
        if x["eval_after_mate"] is not None
        else None
    )
    return (
        "Explain this chess move to a human player using only the supplied facts. "
        "Be concrete and instructional. Explain the key chess idea, why the move "
        "was good or bad, and mention the best move when provided. Do not invent "
        "unsupported variations or tactical claims.\n\n"
        f"FEN: {x['fen']}\n"
        f"Played move: {x['played_move']}\n"
        f"Best move: {x['best_move'] or 'not provided'}\n"
        f"Evaluation before: {before}\n"
        f"Evaluation after: {after}\n"
        f"Loss (cp): {x['loss_cp']}\n"
        f"Classification: {x['classification']}\n"
        f"Motif: {x['motif']}\n"
        f"Motif detail: {json.dumps(x['motif_detail'], ensure_ascii=False, sort_keys=True)}\n"
        f"Color: {x['color']}\n"
        f"Move number: {x['move_number']}"
    )


def flush_game(
    rows: list[dict[str, Any]],
    output: dict[str, TextIO],
    teacher: TextIO,
    split: str,
    rng: random.Random,
    normal_probability: float,
    stats: Counter[str],
) -> None:
    for row in rows:
        classification = row["classification"]
        motif = row["motif"]

        keep = (
            motif != "none"
            or classification in BAD_CLASSES
            or rng.random() < normal_probability
        )
        if not keep:
            stats["rows_filtered_out"] += 1
            continue

        record = make_record(row)
        output[split].write(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        )

        if split in {"train", "validation"} or motif != "none" or classification in BAD_CLASSES:
            teacher.write(
                json.dumps(
                    {
                        "id": record["id"],
                        "game_id": record["game_id"],
                        "input": record["input"],
                        "prompt": teacher_prompt(record),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )

        stats[f"rows_{split}"] += 1
        stats[f"class_{classification}"] += 1
        stats[f"motif_{motif}"] += 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--input",
        type=Path,
        default=Path("data/clean/corpus_unique.jsonl"),
    )
    ap.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/phase6"),
    )
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--normal-keep-probability",
        type=float,
        default=0.20,
        help="Keep probability for best/excellent/good rows.",
    )
    ap.add_argument(
        "--progress-games",
        type=int,
        default=1000,
    )
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Input does not exist: {args.input}")
    if not 0.0 <= args.normal_keep_probability <= 1.0:
        raise SystemExit("--normal-keep-probability must be between 0 and 1")

    args.output_dir.mkdir(parents=True, exist_ok=True)

    paths = {
        "train": args.output_dir / "train.jsonl",
        "validation": args.output_dir / "validation.jsonl",
        "test": args.output_dir / "test.jsonl",
        "teacher_queue": args.output_dir / "teacher_queue.jsonl",
    }

    handles = {k: p.open("w", encoding="utf-8") for k, p in paths.items()}
    rng = random.Random(args.seed)
    stats: Counter[str] = Counter()
    games_seen = 0
    unique_games = set()

    current_game_id: str | None = None
    current_rows: list[dict[str, Any]] = []
    current_split: str | None = None

    try:
        with args.input.open("r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                if not line.strip():
                    continue

                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise SystemExit(
                        f"Invalid JSON in cleaned corpus at line {line_no}: {exc}"
                    ) from exc

                game_id = row.get("game_id")
                if not isinstance(game_id, str) or not game_id:
                    raise SystemExit(f"Invalid game_id at line {line_no}")

                if current_game_id is None:
                    current_game_id = game_id
                    current_split = split_for_game(game_id, args.seed)

                elif game_id != current_game_id:
                    flush_game(
                        current_rows,
                        handles,
                        handles["teacher_queue"],
                        current_split,  # type: ignore[arg-type]
                        rng,
                        args.normal_keep_probability,
                        stats,
                    )
                    handles["train"].flush()
                    handles["validation"].flush()
                    handles["test"].flush()
                    handles["teacher_queue"].flush()

                    games_seen += 1
                    if current_game_id in unique_games:
                        raise SystemExit(
                            f"Game {current_game_id} is non-contiguous in the cleaned corpus"
                        )
                    unique_games.add(current_game_id)

                    if games_seen % args.progress_games == 0:
                        print(
                            f"Games: {games_seen:,} | "
                            f"rows kept: {stats['rows_train'] + stats['rows_validation'] + stats['rows_test']:,}",
                            flush=True,
                        )

                    current_game_id = game_id
                    current_split = split_for_game(game_id, args.seed)
                    current_rows = []

                current_rows.append(row)

            if current_game_id is not None:
                flush_game(
                    current_rows,
                    handles,
                    handles["teacher_queue"],
                    current_split,  # type: ignore[arg-type]
                    rng,
                    args.normal_keep_probability,
                    stats,
                )
                games_seen += 1
                unique_games.add(current_game_id)

    finally:
        for handle in handles.values():
            handle.close()

    manifest = {
        "version": 1,
        "input": str(args.input.resolve()),
        "seed": args.seed,
        "split_rule": "game-level sha256: 90% train, 5% validation, 5% test",
        "normal_keep_probability": args.normal_keep_probability,
        "games_seen": games_seen,
        "unique_games": len(unique_games),
        "stats": dict(stats),
        "outputs": {k: str(v.resolve()) for k, v in paths.items()},
        "note": "baseline_explanation is retained for comparison; teacher_queue targets are generated separately.",
    }

    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\n=== PHASE 6A COMPLETE ===")
    print(f"Games:              {games_seen:,}")
    print(f"Rows train:         {stats['rows_train']:,}")
    print(f"Rows validation:    {stats['rows_validation']:,}")
    print(f"Rows test:          {stats['rows_test']:,}")
    print(f"Rows filtered out:  {stats['rows_filtered_out']:,}")
    print(f"Teacher queue:      {paths['teacher_queue']}")
    print(f"Manifest:           {args.output_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
