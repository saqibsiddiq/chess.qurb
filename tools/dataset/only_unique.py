#!/usr/bin/env python3
"""Deduplicate Chesy JSONL shards at the GAME level.

Pass 1:
  - hashes every game's rows
  - detects game IDs appearing in multiple worker files
  - distinguishes exact duplicates from conflicting copies

Pass 2:
  - writes exactly one copy of each game to the cleaned corpus
  - keeps the first occurrence in worker sort order
  - writes duplicate/conflict reports

Nothing in data/raw is modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def row_bytes(row: dict[str, Any]) -> bytes:
    """Stable representation for comparing rows across workers."""
    return (
        json.dumps(
            row,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def scan_file(path: Path, game_meta: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Hash each game in a file without storing its rows."""
    per_file_games = 0
    per_file_rows = 0

    # A game is normally contiguous, but this implementation does not rely on
    # contiguity: one hasher/counter exists per game ID.
    hashers: dict[str, hashlib._Hash] = {}
    counts: dict[str, int] = defaultdict(int)

    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue

            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Invalid JSON: {path}:{line_no}: {exc}") from exc

            game_id = row.get("game_id")
            if not isinstance(game_id, str) or not game_id:
                raise SystemExit(f"Missing/invalid game_id: {path}:{line_no}")

            if game_id not in hashers:
                hashers[game_id] = hashlib.sha256()
                per_file_games += 1

                game_meta.setdefault(
                    game_id,
                    {
                        "occurrences": [],
                    },
                )

            hashers[game_id].update(row_bytes(row))
            counts[game_id] += 1
            per_file_rows += 1

    worker_name = path.stem
    for game_id, hasher in hashers.items():
        game_meta[game_id]["occurrences"].append(
            {
                "worker": worker_name,
                "path": str(path.resolve()),
                "rows": counts[game_id],
                "sha256": hasher.hexdigest(),
            }
        )

    return {
        "rows": per_file_rows,
        "games": per_file_games,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--output-dir", type=Path, default=Path("data/clean"))
    args = ap.parse_args()

    files = sorted(args.input_dir.glob("worker_*.jsonl"))
    if not files:
        raise SystemExit(f"No worker_*.jsonl files found in {args.input_dir}")

    args.output_dir.mkdir(parents=True, exist_ok=True)

    game_meta: dict[str, dict[str, Any]] = {}

    print("Pass 1/2: hashing games...", flush=True)
    for i, path in enumerate(files, 1):
        print(f"  [{i}/{len(files)}] {path.name}", flush=True)
        stats = scan_file(path, game_meta)
        print(
            f"      {stats['games']:,} games | {stats['rows']:,} rows",
            flush=True,
        )

    duplicate_games: dict[str, Any] = {}
    conflict_games: dict[str, Any] = {}

    for game_id, meta in game_meta.items():
        occurrences = sorted(meta["occurrences"], key=lambda x: x["worker"])
        if len(occurrences) <= 1:
            continue

        hashes = {x["sha256"] for x in occurrences}
        record = {
            "game_id": game_id,
            "occurrences": occurrences,
            "identical": len(hashes) == 1,
        }

        if len(hashes) == 1:
            duplicate_games[game_id] = record
        else:
            conflict_games[game_id] = record

    print()
    print("=== DUPLICATE ANALYSIS ===")
    print(f"Unique game IDs:           {len(game_meta):,}")
    print(f"Duplicate game IDs:        {len(duplicate_games):,}")
    print(f"Conflicting game IDs:      {len(conflict_games):,}")

    duplicate_path = args.output_dir / "duplicate-games.json"
    conflict_path = args.output_dir / "conflicting-games.json"

    duplicate_path.write_text(
        json.dumps(duplicate_games, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    conflict_path.write_text(
        json.dumps(conflict_games, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    if conflict_games and False:
        print()
        print("STOPPING: conflicting copies were found.")
        print(f"Review: {conflict_path}")
        print("The cleaned corpus was NOT created.")
        raise SystemExit(2)

    if duplicate_games:
        print()
        print("Exact duplicate examples:")
        for game_id, record in list(duplicate_games.items())[:10]:
            workers = [x["worker"] for x in record["occurrences"]]
            print(f"  {game_id}: {', '.join(workers)}")

    # We prefer the first worker occurrence after lexical worker sorting.
    keep_owner: dict[str, str] = {}
    for game_id, meta in game_meta.items():
        first = sorted(meta["occurrences"], key=lambda x: x["worker"])[0]
        keep_owner[game_id] = first["worker"]

    clean_path = args.output_dir / "corpus_unique.jsonl"
    duplicate_rows_removed = 0
    rows_written = 0
    games_written = 0
    games_seen = set()

    print("\nPass 2/2: writing unique corpus...", flush=True)
    handles = {
        path.stem: path.open("r", encoding="utf-8")
        for path in files
    }

    try:
        with clean_path.open("w", encoding="utf-8") as out:
            for path in files:
                worker = path.stem
                f = handles[worker]
                for line_no, line in enumerate(f, 1):
                    if not line.strip():
                        continue

                    row = json.loads(line)
                    game_id = row["game_id"]

                    if keep_owner[game_id] == worker:
                        out.write(line)
                        rows_written += 1
                        games_seen.add(game_id)
                    else:
                        duplicate_rows_removed += 1
    finally:
        for handle in handles.values():
            handle.close()

    games_written = len(games_seen)

    manifest = {
        "source_files": [str(p.resolve()) for p in files],
        "source_game_ids": len(game_meta),
        "duplicate_game_ids_removed": len(duplicate_games),
        "conflicting_game_ids": len(conflict_games),
        "unique_games_written": games_written,
        "rows_written": rows_written,
        "duplicate_rows_removed": duplicate_rows_removed,
        "keep_rule": "first occurrence by worker name",
    }

    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\n=== CLEANING COMPLETE ===")
    print(f"Unique games written:       {games_written:,}")
    print(f"Rows written:               {rows_written:,}")
    print(f"Duplicate games removed:   {len(duplicate_games):,}")
    print(f"Duplicate rows removed:     {duplicate_rows_removed:,}")
    print(f"Clean corpus:               {clean_path}")
    print(f"Manifest:                   {manifest_path}")
    print(f"Duplicate report:           {duplicate_path}")


if __name__ == "__main__":
    main()
