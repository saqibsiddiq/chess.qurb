"""
Build a JSONL dataset of chess positions, moves, evaluations,
classifications, motifs, and explanations from real PGN games.

The JSONL file is written incrementally after every successfully
processed game.

Example:
    python extractor.py games.pgn output.jsonl --max-games 100
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import socket
import time
from datetime import datetime, timezone
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TextIO

import chess
import chess.engine
import chess.pgn

try:
    import zstandard
except ImportError:
    zstandard = None

import classify
from motifs import detect_motif
from templates import build_explanation


NEEDS_ENGINE = {"inaccuracy", "mistake", "blunder"}

EVAL_RE = re.compile(
    r"\[%eval\s+(#?-?\d+(?:\.\d+)?)"
)


# ---------------------------------------------------------------------
# Worker / persistence helpers
# ---------------------------------------------------------------------

SCHEMA_VERSION = 2


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def input_metadata(path: Path) -> dict:
    stat = path.stat()
    return {"path": str(path.resolve()), "size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def worker_report_dir(output: Path, worker_id: str, report_dir: Path | None) -> Path:
    result = report_dir or output.parent / "reports" / f"worker_{worker_id}"
    result.mkdir(parents=True, exist_ok=True)
    return result


def malformed_game_reason(game: chess.pgn.Game) -> str | None:
    errors = getattr(game, "errors", None)
    if errors:
        return "; ".join(str(error) for error in errors[:10])
    return None


def validate_rows_for_game(rows: list[Row]) -> list[str]:
    """Cheap validation before this game's rows become durable output."""
    issues: list[str] = []
    seen: set[tuple[str, int, str]] = set()
    for index, row in enumerate(rows, start=1):
        try:
            board = chess.Board(row.fen)
        except ValueError as exc:
            issues.append(f"row {index}: invalid FEN: {exc}")
            continue
        try:
            move = chess.Move.from_uci(row.played_uci)
            if move not in board.legal_moves:
                issues.append(f"row {index}: illegal played move {row.played_uci}")
            elif board.san(move) != row.played_san:
                issues.append(f"row {index}: SAN mismatch")
        except ValueError:
            issues.append(f"row {index}: invalid played UCI {row.played_uci}")
        if row.best_move_uci:
            try:
                best = chess.Move.from_uci(row.best_move_uci)
                if best not in board.legal_moves:
                    issues.append(f"row {index}: illegal best move {row.best_move_uci}")
            except ValueError:
                issues.append(f"row {index}: invalid best UCI {row.best_move_uci}")
        key = (row.game_id, row.move_number, row.color)
        if key in seen:
            issues.append(f"row {index}: duplicate move {key}")
        seen.add(key)
    return issues


# ---------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))

    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)

    if hours:
        return f"{hours}h {minutes}m {seconds}s"

    if minutes:
        return f"{minutes}m {seconds}s"

    return f"{seconds}s"


def print_progress(
    games_processed: int,
    max_games: int,
    started_at: float,
    rows_written: int,
    raw_games_seen: int = 0,
    games_skipped_rating: int = 0,
    games_skipped_malformed: int = 0,
) -> None:
    elapsed = time.monotonic() - started_at

    speed = (
        games_processed / elapsed
        if elapsed > 0
        else 0.0
    )

    remaining = max(
        0,
        max_games - games_processed,
    )

    eta = (
        remaining / speed
        if speed > 0
        else 0.0
    )

    percent = (
        games_processed / max_games * 100
        if max_games > 0
        else 0.0
    )

    print(
        f"Progress: {games_processed}/{max_games} "
        f"({percent:.2f}%) | "
        f"{speed:.3f} games/s | "
        f"ETA: {format_duration(eta)} | "
        f"rows: {rows_written} | "
        f"seen: {raw_games_seen} | "
        f"skipped(rating): {games_skipped_rating} | "
        f"skipped(malformed): {games_skipped_malformed}",
        flush=True,
    )


# ---------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------


def parse_eval_comment(
    comment: str,
) -> tuple[int | None, int | None]:
    """Return (centipawns, mate) from a Lichess [%eval] tag."""

    match = EVAL_RE.search(comment or "")

    if not match:
        return None, None

    raw = match.group(1)

    if raw.startswith("#"):
        return None, int(raw[1:])

    return round(float(raw) * 100), None


# ---------------------------------------------------------------------
# PGN
# ---------------------------------------------------------------------


def open_pgn(path: Path) -> TextIO:
    if path.suffix == ".zst":
        if zstandard is None:
            raise RuntimeError(
                "zstandard is required for .pgn.zst files. "
                "Install it with: pip install zstandard"
            )

        raw = path.open("rb")
        reader = zstandard.ZstdDecompressor().stream_reader(raw)

        return io.TextIOWrapper(
            reader,
            encoding="utf-8",
        )

    return path.open(
        "r",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------
# Dataset row
# ---------------------------------------------------------------------


@dataclass
class Row:
    game_id: str
    fen: str
    move_number: int
    color: str

    played_san: str
    played_uci: str

    eval_before_cp: int | None
    eval_after_cp: int | None

    eval_before_mate: int | None
    eval_after_mate: int | None

    loss_cp: float
    classification: str

    best_move_san: str | None
    best_move_uci: str | None

    motif: str
    motif_detail: dict

    explanation: str

    def to_json(self) -> str:
        return json.dumps(
            asdict(self),
            ensure_ascii=False,
            separators=(",", ":"),
        )


# ---------------------------------------------------------------------
# Process one game
# ---------------------------------------------------------------------


def process_game(
    game: chess.pgn.Game,
    game_id: str,
    engine: chess.engine.SimpleEngine | None,
    depth: int,
    rows: list[Row],
    stats: dict,
) -> None:
    board = game.board()
    node: chess.pgn.GameNode = game

    # Starting position is treated as approximately equal.
    prev_eval: tuple[int | None, int | None] = (
        0,
        None,
    )

    move_number = 0

    while node.variations:
        next_node = node.variations[0]
        move = next_node.move

        is_white = board.turn == chess.WHITE
        color = (
            "white"
            if is_white
            else "black"
        )

        if is_white:
            move_number += 1

        fen_before = board.fen()
        played_san = board.san(move)
        played_uci = move.uci()

        board.push(move)

        eval_before_cp, eval_before_mate = prev_eval

        eval_after_cp, eval_after_mate = (
            parse_eval_comment(
                next_node.comment
            )
        )

        # -------------------------------------------------------------
        # Missing evaluation
        # -------------------------------------------------------------

        if (
            engine is not None
            and eval_after_cp is None
            and eval_after_mate is None
        ):
            info = engine.analyse(
                board,
                chess.engine.Limit(
                    depth=depth
                ),
            )

            score = info["score"].white()

            eval_after_cp = score.score()
            eval_after_mate = score.mate()

        # -------------------------------------------------------------
        # Evaluation loss
        # -------------------------------------------------------------

        cp_before = classify.to_cp_value(
            eval_before_cp,
            eval_before_mate,
        )

        cp_after = classify.to_cp_value(
            eval_after_cp,
            eval_after_mate,
        )

        raw_delta = (
            cp_before - cp_after
            if is_white
            else cp_after - cp_before
        )

        loss_cp = max(
            0.0,
            float(raw_delta),
        )

        is_checkmate = board.is_checkmate()

        # Win% is always from the mover's perspective; cp values above are
        # White-relative.
        wp_before = (
            classify.win_percent(cp_before)
            if is_white
            else 100 - classify.win_percent(cp_before)
        )
        wp_after = (
            classify.win_percent(cp_after)
            if is_white
            else 100 - classify.win_percent(cp_after)
        )

        is_opening_theory_candidate = classify.is_opening_theory_candidate(
            fen_before,
            played_uci,
        )

        # Initial classification before best-move search — decides
        # whether engine analysis is needed at all.
        classification = classify.classify(
            loss_cp,
            played_uci,
            None,
            wp_before,
            wp_after,
            is_checkmate,
            is_opening_theory_candidate,
            None,
        )

        best_san: str | None = None
        best_uci: str | None = None

        motif = "none"
        motif_detail: dict = {}

        # -------------------------------------------------------------
        # Engine analysis for candidate mistakes
        # -------------------------------------------------------------

        if (
            engine is not None
            and classification in NEEDS_ENGINE
        ):
            board_before = chess.Board(
                fen_before
            )

            info = engine.analyse(
                board_before,
                chess.engine.Limit(
                    depth=depth
                ),
            )

            pv = info.get("pv", [])

            if pv:
                best_move = pv[0]

                best_san = board_before.san(
                    best_move
                )

                best_uci = best_move.uci()

            # Reclassify using the actual best move (motif not known yet,
            # this is only used to gate/inform the motif detector below —
            # same two-stage pattern the original extractor used).
            pre_motif_classification = classify.classify(
                loss_cp,
                played_uci,
                best_uci,
                wp_before,
                wp_after,
                is_checkmate,
                is_opening_theory_candidate,
                None,
            )

            result = detect_motif(
                board_before=board_before,
                board_after=board,
                move=move,
                mover_is_white=is_white,
                eval_before_mate=eval_before_mate,
                eval_after_mate=eval_after_mate,
                best_move_uci=best_uci,
                classification=pre_motif_classification,
            )

            motif = result.motif
            motif_detail = result.detail

            missed_tactic_motif = (
                motif
                if motif in ("missed_mate", "fork", "pin", "skewer")
                else None
            )

            # Final classification, now that motif is known — may upgrade
            # a mistake/blunder to "miss".
            classification = classify.classify(
                loss_cp,
                played_uci,
                best_uci,
                wp_before,
                wp_after,
                is_checkmate,
                is_opening_theory_candidate,
                missed_tactic_motif,
            )

        # -------------------------------------------------------------
        # Actual checkmate
        # -------------------------------------------------------------

        if is_checkmate:
            motif = "mate"
            motif_detail = {}

        # -------------------------------------------------------------
        # Explanation
        # -------------------------------------------------------------

        explanation = build_explanation(
            classification,
            motif,
            motif_detail,
            played_san,
            best_san,
            loss_cp,
            variant=(
                move_number
                + (0 if is_white else 1)
            ) % 3,
        )

        # -------------------------------------------------------------
        # Dataset row
        # -------------------------------------------------------------

        rows.append(
            Row(
                game_id=game_id,
                fen=fen_before,
                move_number=move_number,
                color=color,
                played_san=played_san,
                played_uci=played_uci,
                eval_before_cp=eval_before_cp,
                eval_after_cp=eval_after_cp,
                eval_before_mate=eval_before_mate,
                eval_after_mate=eval_after_mate,
                loss_cp=loss_cp,
                classification=classification,
                best_move_san=best_san,
                best_move_uci=best_uci,
                motif=motif,
                motif_detail=motif_detail,
                explanation=explanation,
            )
        )

        stats["classification"][classification] = (
            stats["classification"].get(
                classification,
                0,
            )
            + 1
        )

        stats["motif"][motif] = (
            stats["motif"].get(
                motif,
                0,
            )
            + 1
        )

        prev_eval = (
            eval_after_cp,
            eval_after_mate,
        )

        node = next_node


# ---------------------------------------------------------------------
# Streaming validation
# ---------------------------------------------------------------------


def validate_jsonl(
    path: Path,
) -> tuple[int, int, list[str]]:
    total_rows = 0
    issue_count = 0
    issues: list[str] = []

    seen: set[
        tuple[str, int, str]
    ] = set()

    with path.open(
        "r",
        encoding="utf-8",
    ) as f:

        for line_number, line in enumerate(
            f,
            start=1,
        ):
            if not line.strip():
                continue

            total_rows += 1

            try:
                obj = json.loads(line)
                row = Row(**obj)

            except Exception as exc:
                issue_count += 1

                if len(issues) < 200:
                    issues.append(
                        f"line {line_number}: "
                        f"invalid JSON/row: {exc}"
                    )

                continue

            try:
                board = chess.Board(
                    row.fen
                )
            except ValueError as exc:
                issue_count += 1

                if len(issues) < 200:
                    issues.append(
                        f"line {line_number}: "
                        f"invalid FEN: {exc}"
                    )

                continue

            # ---------------------------------------------------------
            # Played move
            # ---------------------------------------------------------

            try:
                move = chess.Move.from_uci(
                    row.played_uci
                )

                if move not in board.legal_moves:
                    issue_count += 1

                    if len(issues) < 200:
                        issues.append(
                            f"line {line_number}: "
                            f"played move "
                            f"{row.played_uci} "
                            "is illegal"
                        )

                else:
                    recomputed_san = board.san(
                        move
                    )

                    if recomputed_san != row.played_san:
                        issue_count += 1

                        if len(issues) < 200:
                            issues.append(
                                f"line {line_number}: "
                                f"SAN mismatch "
                                f"(expected "
                                f"{recomputed_san}, "
                                f"stored "
                                f"{row.played_san})"
                            )

            except ValueError:
                issue_count += 1

                if len(issues) < 200:
                    issues.append(
                        f"line {line_number}: "
                        f"invalid played UCI "
                        f"{row.played_uci}"
                    )

            # ---------------------------------------------------------
            # Best move
            # ---------------------------------------------------------

            if row.best_move_uci:
                try:
                    best = chess.Move.from_uci(
                        row.best_move_uci
                    )

                    if best not in board.legal_moves:
                        issue_count += 1

                        if len(issues) < 200:
                            issues.append(
                                f"line {line_number}: "
                                f"best move "
                                f"{row.best_move_uci} "
                                "is illegal"
                            )

                except ValueError:
                    issue_count += 1

                    if len(issues) < 200:
                        issues.append(
                            f"line {line_number}: "
                            f"invalid best UCI "
                            f"{row.best_move_uci}"
                        )

            # ---------------------------------------------------------
            # Duplicate move
            # ---------------------------------------------------------

            key = (
                row.game_id,
                row.move_number,
                row.color,
            )

            if key in seen:
                issue_count += 1

                if len(issues) < 200:
                    issues.append(
                        f"line {line_number}: "
                        f"duplicate move {key}"
                    )

            seen.add(key)

    return (
        total_rows,
        issue_count,
        issues,
    )


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Input .pgn or .pgn.zst file")
    parser.add_argument("output", type=Path, help="Worker JSONL output file")
    parser.add_argument("--max-games", type=int, default=20)
    parser.add_argument("--min-rating", type=int, default=0)
    parser.add_argument("--max-rating", type=int, default=4000)
    parser.add_argument("--depth", type=int, default=14)
    parser.add_argument("--stockfish-path", default="stockfish")
    parser.add_argument("--no-engine", action="store_true")
    parser.add_argument("--skip-games", type=int, default=0, help="Skip this many accepted games before processing")
    parser.add_argument("--progress-every", type=int, default=100)
    parser.add_argument("--worker-id", default="0")
    parser.add_argument("--report-dir", type=Path, default=None)
    parser.add_argument("--resume", action="store_true", help="Resume from worker checkpoint")
    parser.add_argument("--malformed-log", type=Path, default=None)
    args = parser.parse_args()

    if args.max_games <= 0:
        raise SystemExit("--max-games must be greater than 0")
    if args.progress_every <= 0:
        raise SystemExit("--progress-every must be greater than 0")
    if args.skip_games < 0:
        raise SystemExit("--skip-games must be >= 0")
    if args.depth <= 0:
        raise SystemExit("--depth must be greater than 0")
    if not args.input.exists():
        raise SystemExit(f"Input does not exist: {args.input}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    report_dir = worker_report_dir(args.output, str(args.worker_id), args.report_dir)
    checkpoint_path = report_dir / "checkpoint.json"
    metadata_path = report_dir / "metadata.json"
    validation_path = report_dir / "validation-report.json"
    summary_path = report_dir / "classification-summary.json"
    malformed_log_path = args.malformed_log or (report_dir / "malformed-games.jsonl")

    checkpoint: dict = {}
    if args.resume:
        if not checkpoint_path.exists() or not args.output.exists():
            raise SystemExit("--resume requires an existing checkpoint and JSONL output")
        checkpoint = load_json(checkpoint_path)
        if checkpoint.get("input", {}).get("path") not in (None, str(args.input.resolve())):
            raise SystemExit("Checkpoint input does not match current input file")

    games_processed = int(checkpoint.get("games_processed", 0))
    raw_games_seen = int(checkpoint.get("raw_games_seen", 0))
    games_skipped_rating = int(checkpoint.get("games_skipped_rating", 0))
    games_skipped_malformed = int(checkpoint.get("games_skipped_malformed", 0))
    games_skipped_manual = int(checkpoint.get("games_skipped_manual", 0))
    total_rows_written = int(checkpoint.get("total_rows_written", 0))
    games_to_skip_remaining = int(checkpoint.get("games_to_skip_remaining", args.skip_games))
    stats = checkpoint.get("stats", {"classification": {}, "motif": {}})
    resume_raw_target = int(checkpoint.get("raw_games_seen", 0)) if args.resume else 0

    if args.output.exists() and not args.resume:
        raise SystemExit(f"Output already exists: {args.output}. Use a different file or --resume.")

    def save_checkpoint(status: str = "running", last_game_id: str | None = None) -> None:
        atomic_write_json(checkpoint_path, {
            "schema_version": SCHEMA_VERSION,
            "worker_id": str(args.worker_id),
            "status": status,
            "updated_at": utc_now(),
            "run_started_at": metadata["started_at"],
            "input": input_metadata(args.input),
            "output": str(args.output.resolve()),
            "report_dir": str(report_dir.resolve()),
            "games_processed": games_processed,
            "raw_games_seen": raw_games_seen,
            "games_skipped_rating": games_skipped_rating,
            "games_skipped_malformed": games_skipped_malformed,
            "games_skipped_manual": games_skipped_manual,
            "games_to_skip_remaining": games_to_skip_remaining,
            "total_rows_written": total_rows_written,
            "last_game_id": last_game_id,
            "stats": stats,
        })

    metadata = {
        "schema_version": SCHEMA_VERSION,
        "worker_id": str(args.worker_id),
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "started_at": checkpoint.get("run_started_at", utc_now()),
        "last_started_at": utc_now(),
        "input": input_metadata(args.input),
        "output": str(args.output.resolve()),
        "report_dir": str(report_dir.resolve()),
        "config": vars(args) | {"report_dir": str(report_dir.resolve())},
        "status": "running",
    }
    # Path objects are not JSON serializable.
    metadata["config"] = {k: (str(v) if isinstance(v, Path) else v) for k, v in metadata["config"].items()}
    atomic_write_json(metadata_path, metadata)

    engine = None
    malformed_log = None
    started_at = time.monotonic()

    try:
        if not args.no_engine:
            engine = chess.engine.SimpleEngine.popen_uci(args.stockfish_path)

        output_mode = "a" if args.resume else "x"
        with args.output.open(output_mode, encoding="utf-8", buffering=1) as out:
            malformed_log_path.parent.mkdir(parents=True, exist_ok=True)
            malformed_log = malformed_log_path.open("a", encoding="utf-8", buffering=1)

            with open_pgn(args.input) as pgn_file:
                while games_processed < args.max_games:
                    game = chess.pgn.read_game(pgn_file)
                    if game is None:
                        break

                    raw_games_seen += 1

                    if args.resume and raw_games_seen <= resume_raw_target:
                        continue

                    malformed_reason = malformed_game_reason(game)
                    if malformed_reason:
                        games_skipped_malformed += 1
                        malformed_log.write(json.dumps({
                            "worker_id": str(args.worker_id),
                            "raw_game_index": raw_games_seen,
                            "reason": malformed_reason,
                            "site": game.headers.get("Site"),
                            "white": game.headers.get("White"),
                            "black": game.headers.get("Black"),
                        }, ensure_ascii=False, separators=(",", ":")) + "\n")
                        malformed_log.flush()
                        save_checkpoint()
                        continue

                    white_elo = game.headers.get("WhiteElo", "?")
                    black_elo = game.headers.get("BlackElo", "?")
                    if white_elo.isdigit() and black_elo.isdigit():
                        if not (
                            args.min_rating <= int(white_elo) <= args.max_rating
                            and args.min_rating <= int(black_elo) <= args.max_rating
                        ):
                            games_skipped_rating += 1
                            save_checkpoint()
                            continue

                    if games_to_skip_remaining > 0:
                        games_to_skip_remaining -= 1
                        games_skipped_manual += 1
                        save_checkpoint()
                        continue

                    game_id = game.headers.get("Site", f"worker-{args.worker_id}-game-{games_processed + 1}").rsplit("/", 1)[-1]

                    # Exactly one game's rows exist in RAM.
                    rows: list[Row] = []
                    process_game(game, game_id, engine, args.depth, rows, stats)

                    if not rows:
                        games_skipped_malformed += 1
                        malformed_log.write(json.dumps({
                            "worker_id": str(args.worker_id),
                            "raw_game_index": raw_games_seen,
                            "game_id": game_id,
                            "reason": "game produced zero dataset rows",
                        }, ensure_ascii=False, separators=(",", ":")) + "\n")
                        malformed_log.flush()
                        save_checkpoint()
                        continue

                    game_issues = validate_rows_for_game(rows)
                    if game_issues:
                        raise RuntimeError(f"Validation failed for game {game_id}: {' | '.join(game_issues[:20])}")

                    for row in rows:
                        out.write(row.to_json())
                        out.write("\n")
                    out.flush()

                    games_processed += 1
                    total_rows_written += len(rows)
                    save_checkpoint(last_game_id=game_id)

                    if (
                        games_processed == 1
                        or games_processed % args.progress_every == 0
                        or games_processed == args.max_games
                    ):
                        print_progress(
                            games_processed,
                            args.max_games,
                            started_at,
                            total_rows_written,
                            raw_games_seen,
                            games_skipped_rating,
                            games_skipped_malformed,
                        )

    except KeyboardInterrupt:
        print("\nInterrupted by user.", flush=True)
        print(f"Partial dataset preserved at: {args.output}", flush=True)
        print(f"Checkpoint preserved at: {checkpoint_path}", flush=True)
        raise
    finally:
        if malformed_log is not None:
            malformed_log.close()
        if engine is not None:
            engine.quit()

    total_rows, issue_count, issues = validate_jsonl(args.output)
    atomic_write_json(validation_path, {
        "schema_version": SCHEMA_VERSION,
        "worker_id": str(args.worker_id),
        "total_rows": total_rows,
        "issue_count": issue_count,
        "issues": issues,
    })
    atomic_write_json(summary_path, stats)

    elapsed = time.monotonic() - started_at
    speed = games_processed / elapsed if elapsed > 0 else 0.0
    final_status = "completed" if issue_count == 0 else "completed_with_validation_errors"
    save_checkpoint(status=final_status)
    metadata["status"] = final_status
    metadata["completed_at"] = utc_now()
    atomic_write_json(metadata_path, metadata)

    print()
    print(f"Worker: {args.worker_id}", flush=True)
    print(f"Games processed: {games_processed}", flush=True)
    print(f"Raw games read: {raw_games_seen}", flush=True)
    print(f"Skipped by rating: {games_skipped_rating}", flush=True)
    print(f"Skipped malformed: {games_skipped_malformed}", flush=True)
    print(f"Skipped manually: {games_skipped_manual}", flush=True)
    print(f"Positions written: {total_rows_written}", flush=True)
    print(f"Elapsed: {format_duration(elapsed)}", flush=True)
    print(f"Average speed: {speed:.3f} games/s", flush=True)
    print(f"Validation issues: {issue_count}", flush=True)
    print(f"Wrote: {args.output}", flush=True)
    print(f"Reports: {report_dir}", flush=True)


if __name__ == "__main__":
    main()