#!/usr/bin/env python3
"""Mine a lightweight opening book from Chesy's own game corpus.

Chess.com's "Book" classification means a move follows known opening
theory. Chesy has no licensed ECO/theory database, but it does have a large
corpus of real games (data/clean/corpus_unique.jsonl). This script mines
that corpus instead: a position+move pair is "book" if it was played by at
least --min-games distinct games within the first --max-move-number full
moves.

This is an explicit approximation, not a real theory database — see
ml/specs/review_contract.md section 9. The corpus isn't filtered by game
quality, so some dubious tries may appear alongside real theory at low
thresholds; --min-games is the knob to trade recall for precision.

Output: a single JSON object mapping a position key (the FEN's first 4
space-separated fields — piece placement, side to move, castling rights,
en-passant square; halfmove/fullmove counters are dropped since they don't
affect book membership) to the list of UCI moves considered book from that
position. Written compactly (sorted keys, no whitespace).

The canonical copy lives under data/reference/ — the dataset pipeline
(dataset/src/classify.py) reads from there, not from the app. --app-copy
additionally writes a bundled copy into the app's source tree for Vite to
import; that copy is a generated artifact, not a second source of truth.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


def position_key(fen: str) -> str:
    return " ".join(fen.split(" ")[:4])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/clean/corpus_unique.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/reference/opening_book.json"))
    ap.add_argument(
        "--app-copy",
        type=str,
        default="app/src/data/openingBook.json",
        help="Bundled copy for the app to import. Pass an empty string to skip.",
    )
    ap.add_argument("--min-games", type=int, default=10)
    ap.add_argument("--max-move-number", type=int, default=10)
    args = ap.parse_args()

    # (position_key, uci) -> set of game_ids that played it
    occurrences: dict[tuple[str, str], set[str]] = defaultdict(set)

    print(f"Scanning {args.input} (move_number <= {args.max_move_number})...", flush=True)
    rows_seen = 0
    rows_considered = 0
    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            rows_seen += 1
            if rows_seen % 500_000 == 0:
                print(f"  ...{rows_seen:,} rows scanned", flush=True)

            if row.get("move_number", 0) > args.max_move_number:
                continue
            fen = row.get("fen")
            uci = row.get("played_uci")
            game_id = row.get("game_id")
            if not fen or not uci or not game_id:
                continue

            rows_considered += 1
            occurrences[(position_key(fen), uci)].add(game_id)

    print(f"Rows scanned: {rows_seen:,} | considered: {rows_considered:,}", flush=True)

    book: dict[str, list[str]] = defaultdict(list)
    kept_pairs = 0
    for (pos_key, uci), game_ids in occurrences.items():
        if len(game_ids) >= args.min_games:
            book[pos_key].append(uci)
            kept_pairs += 1

    for moves in book.values():
        moves.sort()

    payload = json.dumps(book, sort_keys=True, separators=(",", ":"))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(payload, encoding="utf-8")

    print("\n=== OPENING BOOK BUILT ===")
    print(f"Positions:   {len(book):,}")
    print(f"Position+move pairs kept (>= {args.min_games} games): {kept_pairs:,}")
    print(f"Canonical output: {args.output} ({args.output.stat().st_size / 1024:.1f} KB)")

    if args.app_copy:
        app_copy = Path(args.app_copy)
        app_copy.parent.mkdir(parents=True, exist_ok=True)
        app_copy.write_text(payload, encoding="utf-8")
        print(f"App copy:         {app_copy} ({app_copy.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
