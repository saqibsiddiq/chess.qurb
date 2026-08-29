#!/usr/bin/env python3
"""Cross-check teacher-generated explanations against the structured
facts they were supposed to be grounded in.

This exists because testing free LLM options for Chesy's teacher pipeline
turned up two concrete, repeatable failure modes:
  1. A local 7B model fabricated checkmate/check claims not supported by
     the facts at all.
  2. gemini-3.5-flash-lite correctly described a "pin" motif's shape but
     substituted the wrong square for the pinned piece's target
     (motif_detail said target_square="b6"; the generated text said
     "f3" instead — a different piece's square entirely).

This is NOT a general-purpose hallucination detector — it only checks
what's cheaply and reliably checkable: whether the exact squares named in
motif_detail literally appear in the explanation text, and whether
check/checkmate claims are backed by real mate data or an actual board
simulation (via python-chess). A row that passes is not guaranteed fully
accurate; a row that fails very likely contains a real, specific error.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import chess

SQUARE_RE = re.compile(r"\b([a-h][1-8])\b")
CHECKMATE_RE = re.compile(r"checkmat\w*", re.IGNORECASE)
CHECK_RE = re.compile(r"\bcheck(?:s|ed|ing)?\b", re.IGNORECASE)

MOTIF_REQUIRED_SQUARES = {
    "hanging_piece": lambda d: [s for s in (d.get("square"), d.get("attacker_square")) if s],
    "pin": lambda d: [s for s in (d.get("square"), d.get("target_square")) if s],
    "skewer": lambda d: [s for s in (d.get("front_square"), d.get("behind_square")) if s],
    "discovered_attack": lambda d: [s for s in (d.get("target_square"), d.get("attacker_square")) if s],
    "back_rank": lambda d: [s for s in (d.get("square"),) if s],
    "fork": lambda d: [
        t.get("square") for t in d.get("targets", []) if isinstance(t, dict) and t.get("square")
    ],
}


def required_squares(motif: str, detail: dict) -> list[str]:
    fn = MOTIF_REQUIRED_SQUARES.get(motif)
    return fn(detail) if fn else []


def mentioned_squares(text: str) -> set[str]:
    return {m.lower() for m in SQUARE_RE.findall(text)}


def gives_check(fen: str | None, uci: str | None) -> bool | None:
    if not fen or not uci:
        return None
    try:
        board = chess.Board(fen)
        board.push_uci(uci)
        return board.is_check()
    except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError):
        return None


def verify_row(input_facts: dict, explanation: str) -> list[str]:
    problems = []
    motif = input_facts.get("motif", "none")
    detail = input_facts.get("motif_detail") or {}

    # 1. Required squares from motif_detail must be literally present —
    # catches both omission and substitution (the flash-lite failure).
    req = required_squares(motif, detail)
    mentioned = mentioned_squares(explanation)
    missing = [s for s in req if s.lower() not in mentioned]
    if missing:
        problems.append(f"motif={motif} requires squares {req} but explanation is missing {missing}")

    # 2. Checkmate claims must be backed by real mate data — catches the
    # local-model failure (fabricated checkmate with no mate anywhere in
    # the facts).
    if CHECKMATE_RE.search(explanation):
        backed = (
            motif in ("mate", "missed_mate", "allowed_mate")
            or input_facts.get("eval_before_mate") is not None
            or input_facts.get("eval_after_mate") is not None
        )
        if not backed:
            problems.append("explanation claims checkmate but no mate data supports it")

    # 3. Plain "check" claims (not already covered by a checkmate mention,
    # since checkmate implies check) must be backed by actually replaying
    # the move on the real board.
    if CHECK_RE.search(explanation) and not CHECKMATE_RE.search(explanation):
        fen = input_facts.get("fen")
        played_check = gives_check(fen, input_facts.get("played_uci"))
        best_check = gives_check(fen, input_facts.get("best_move_uci"))
        if fen and played_check is False and best_check in (False, None):
            problems.append(
                "explanation mentions 'check' but neither the played nor best move actually gives check"
            )

    return problems


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Pilot file with input facts (e.g. data/phase6/teacher_pilot_10k.jsonl)",
    )
    ap.add_argument("--teacher-output", type=Path, required=True)
    ap.add_argument("--passed", type=Path, default=Path("teacher_output_verified.jsonl"))
    ap.add_argument("--flagged", type=Path, default=Path("teacher_output_flagged.jsonl"))
    args = ap.parse_args()

    facts = {}
    with args.source.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            facts[row["id"]] = row["input"]

    passed = flagged = missing_source = 0
    args.passed.parent.mkdir(parents=True, exist_ok=True)
    args.flagged.parent.mkdir(parents=True, exist_ok=True)

    with args.teacher_output.open("r", encoding="utf-8") as f_in, \
         args.passed.open("w", encoding="utf-8") as f_pass, \
         args.flagged.open("w", encoding="utf-8") as f_flag:
        for line in f_in:
            if not line.strip():
                continue
            row = json.loads(line)
            input_facts = facts.get(row["id"])
            if input_facts is None:
                missing_source += 1
                continue

            problems = verify_row(input_facts, row["explanation"])
            if problems:
                flagged += 1
                f_flag.write(json.dumps({**row, "problems": problems}, ensure_ascii=False) + "\n")
            else:
                passed += 1
                f_pass.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("=== VERIFICATION ===")
    print(f"Passed:              {passed}")
    print(f"Flagged:             {flagged}")
    print(f"Missing source facts: {missing_source}")
    print(f"Verified output: {args.passed}")
    print(f"Flagged for review: {args.flagged}")


if __name__ == "__main__":
    main()
