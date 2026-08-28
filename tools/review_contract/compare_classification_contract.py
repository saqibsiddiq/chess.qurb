#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

TS_CLASSES = (
    "best",
    "excellent",
    "good",
    "inaccuracy",
    "mistake",
    "blunder",
)

MATE_SCORE = 100_000


def ts_to_cp_value(cp, mate, is_white_turn: bool):
    """Reproduce src/lib/reviewEngine.ts toCpValue()."""
    if mate is not None:
        if mate == 0:
            return -MATE_SCORE if is_white_turn else MATE_SCORE

        return (
            MATE_SCORE - mate * 10
            if mate > 0
            else -MATE_SCORE - mate * 10
        )

    return cp if cp is not None else 0


def win_percent(cp: float) -> float:
    """Reproduce the live Lichess win-percent transform."""
    return 50 + 50 * (
        2 / (1 + math.exp(-0.00368208 * cp)) - 1
    )


def extractor_classify(
    loss_cp: float,
    played_uci: str,
    best_uci: str | None,
    is_checkmate: bool,
) -> str:
    """
    Reproduce the COMPLETE dataset classification semantics.

    Important:
    The real extractor applies a final:
        checkmate -> best
    override after engine analysis.
    """
    if is_checkmate:
        return "best"

    if best_uci is not None and played_uci == best_uci:
        return "best"

    if loss_cp < 5:
        return "best"

    if loss_cp < 20:
        return "excellent"

    if loss_cp < 50:
        return "good"

    if loss_cp < 100:
        return "inaccuracy"

    if loss_cp < 200:
        return "mistake"

    return "blunder"


def ts_classify(
    loss_cp: float,
    played_uci: str,
    best_uci: str | None,
    wp_before: float,
    wp_after: float,
    is_checkmate: bool,
) -> str:
    """Reproduce src/lib/reviewEngine.ts classify()."""
    if (
        is_checkmate
        or (best_uci is not None and played_uci == best_uci)
        or loss_cp < 5
    ):
        return "best"

    wp_drop = max(0.0, wp_before - wp_after)

    if wp_before > 95 and wp_after > 90:
        if loss_cp < 50:
            return "excellent"
        return "good"

    if wp_drop < 2.5 and loss_cp < 25:
        return "best"

    if wp_drop < 5.0 and loss_cp < 50:
        return "excellent"

    if wp_drop < 10.0 and loss_cp < 100:
        return "good"

    if wp_drop < 18.0 and loss_cp < 180:
        return "inaccuracy"

    if wp_drop < 30.0 and loss_cp < 320:
        return "mistake"

    return "blunder"


def is_checkmate_from_row(row: dict) -> bool:
    """Reconstruct fenAfter and reproduce the app's checkmate test."""
    import chess

    board = chess.Board(row["fen"])
    board.push_uci(row["played_uci"])
    return board.is_checkmate()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--input",
        type=Path,
        default=Path("data/clean/corpus_unique.jsonl"),
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=Path("data/audit/classification_contract_diff.json"),
    )
    ap.add_argument(
        "--sample",
        type=int,
        default=0,
        help="Check only the first N rows; 0 means all rows.",
    )
    ap.add_argument(
        "--example-limit",
        type=int,
        default=50,
    )
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Input not found: {args.input}")

    if args.sample < 0:
        raise SystemExit("--sample cannot be negative")

    args.output.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    mismatches = 0
    checkmates = 0
    missing_best = 0

    dataset_counts = Counter()
    ts_counts = Counter()
    confusion = Counter()

    mismatch_examples = []
    lopsided_mismatch_examples = []

    with args.input.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue

            if args.sample and total >= args.sample:
                break

            row = json.loads(line)

            loss_cp = float(row["loss_cp"])
            played_uci = row["played_uci"]
            best_uci = row.get("best_move_uci")
            dataset_label = row["classification"]

            try:
                checkmate = is_checkmate_from_row(row)
            except Exception as exc:
                raise SystemExit(
                    f"Could not reconstruct board at line {line_no}: "
                    f"{exc}; game={row.get('game_id')}"
                ) from exc

            # Reproduce the extractor exactly, INCLUDING its final
            # checkmate override.
            extractor_label = extractor_classify(
                loss_cp=loss_cp,
                played_uci=played_uci,
                best_uci=best_uci,
                is_checkmate=checkmate,
            )

            if dataset_label != extractor_label:
                raise SystemExit(
                    "Stored dataset classification does not match "
                    f"extractor semantics at line {line_no}: "
                    f"stored={dataset_label}, "
                    f"computed={extractor_label}, "
                    f"checkmate={checkmate}, "
                    f"game={row.get('game_id')}"
                )

            if checkmate:
                checkmates += 1

            if best_uci is None:
                missing_best += 1

            # Reproduce the live TS evaluation orientation.
            #
            # The dataset extractor stores evaluations from White's
            # perspective. The TS review engine converts those values
            # to the mover's perspective before calculating win%.
            #
            # For the "after" position, TS passes nextTurnIsWhite,
            # so the raw score conversion is intentionally based on
            # the opposite side to move.
            cp_before = ts_to_cp_value(
                row.get("eval_before_cp"),
                row.get("eval_before_mate"),
                row["color"] == "w",
            )

            next_turn_is_white = row["color"] == "b"

            if checkmate:
                cp_after = (
                    MATE_SCORE
                    if row["color"] == "w"
                    else -MATE_SCORE
                )
            else:
                cp_after = ts_to_cp_value(
                    row.get("eval_after_cp"),
                    row.get("eval_after_mate"),
                    next_turn_is_white,
                )

            # Convert the engine score to the mover's win probability.
            before_white_wp = win_percent(cp_before)
            after_white_wp = win_percent(cp_after)

            if row["color"] == "w":
                wp_before = before_white_wp
                wp_after = after_white_wp
            else:
                wp_before = 100 - before_white_wp
                wp_after = 100 - after_white_wp

            live_label = ts_classify(
                loss_cp=loss_cp,
                played_uci=played_uci,
                best_uci=best_uci,
                wp_before=wp_before,
                wp_after=wp_after,
                is_checkmate=checkmate,
            )

            total += 1

            dataset_counts[dataset_label] += 1
            ts_counts[live_label] += 1
            confusion[(dataset_label, live_label)] += 1

            if dataset_label != live_label:
                mismatches += 1

                example = {
                    "game_id": row.get("game_id"),
                    "move_number": row.get("move_number"),
                    "color": row.get("color"),
                    "classification_dataset": dataset_label,
                    "classification_ts": live_label,
                    "loss_cp": loss_cp,
                    "played_uci": played_uci,
                    "best_move_uci": best_uci,
                    "eval_before_cp": row.get("eval_before_cp"),
                    "eval_after_cp": row.get("eval_after_cp"),
                    "eval_before_mate": row.get("eval_before_mate"),
                    "eval_after_mate": row.get("eval_after_mate"),
                    "wp_before": round(wp_before, 6),
                    "wp_after": round(wp_after, 6),
                    "wp_drop": round(
                        max(0.0, wp_before - wp_after),
                        6,
                    ),
                }

                if len(mismatch_examples) < args.example_limit:
                    mismatch_examples.append(example)

                if (
                    wp_before > 95
                    and wp_after > 90
                    and len(lopsided_mismatch_examples)
                    < args.example_limit
                ):
                    lopsided_mismatch_examples.append(example)

            if total % 250_000 == 0:
                print(
                    f"Rows checked: {total:,} | "
                    f"mismatches: {mismatches:,}",
                    flush=True,
                )

    mismatch_rate = (
        mismatches / total * 100
        if total
        else 0.0
    )

    report = {
        "version": 2,
        "input": str(args.input.resolve()),
        "rows_checked": total,
        "checkmate_rows": checkmates,
        "missing_best_move_rows": missing_best,
        "mismatches": mismatches,
        "mismatch_rate_percent": mismatch_rate,
        "dataset_classifier": {
            "source": "dataset/extractor.py",
            "rules": [
                "checkmate -> best",
                "played == best -> best",
                "loss < 5 -> best",
                "loss < 20 -> excellent",
                "loss < 50 -> good",
                "loss < 100 -> inaccuracy",
                "loss < 200 -> mistake",
                "otherwise blunder",
            ],
        },
        "live_ts_classifier": {
            "source": "src/lib/reviewEngine.ts",
            "rules": [
                "checkmate or played == best or loss < 5 -> best",
                "lopsided-position exception",
                "win-percent drop + loss_cp thresholds",
            ],
        },
        "classification_counts_dataset": dict(dataset_counts),
        "classification_counts_ts": dict(ts_counts),
        "confusion_matrix": {
            f"{a}->{b}": count
            for (a, b), count in sorted(confusion.items())
        },
        "mismatch_examples": mismatch_examples,
        "lopsided_mismatch_examples": lopsided_mismatch_examples,
    }

    args.output.write_text(
        json.dumps(
            report,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print("\n=== CLASSIFICATION CONTRACT DIFF ===")
    print(f"Rows checked:       {total:,}")
    print(f"Mismatches:         {mismatches:,}")
    print(f"Mismatch rate:      {mismatch_rate:.4f}%")
    print(f"Checkmate rows:     {checkmates:,}")
    print(f"Missing best move:  {missing_best:,}")

    print("\nDataset labels:")
    for label in TS_CLASSES:
        print(f"  {label:11s} {dataset_counts[label]:,}")

    print("\nLive TS labels:")
    for label in TS_CLASSES:
        print(f"  {label:11s} {ts_counts[label]:,}")

    print("\nTop disagreements:")
    disagreements = sorted(
        (
            (count, source, target)
            for (source, target), count in confusion.items()
            if source != target
        ),
        reverse=True,
    )

    for count, source, target in disagreements[:15]:
        print(
            f"  {source:11s} -> {target:11s}: {count:,}"
        )

    print(f"\nReport: {args.output}")


if __name__ == "__main__":
    main()
 