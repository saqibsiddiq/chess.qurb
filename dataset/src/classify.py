"""
Chesy's own review classifier.

Six classes (best/excellent/good/inaccuracy/mistake/blunder) are Chesy's
own win%/cp-loss engine logic. Book and Miss are documented heuristic
approximations informed by public descriptions of Chess.com's behavior.
Great and Brilliant are intentionally absent from this module — they need
a second engine line (MultiPV) that most of the corpus does not have. See
ml/specs/classification_policy.md for the full per-class status table.

This is not a reproduction of Chess.com's proprietary algorithm.

This module is the single Python source of truth for the classification
formula — dataset/src/extractor.py, tools/dataset/reclassify.py, and
tools/review_contract/compare_classification_contract.py all import it
rather than each maintaining their own copy, which is how the dataset and
the live app (app/src/lib/reviewEngine.ts) drifted apart in the first
place.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import chess

MATE_SENTINEL = 100_000
BOOK_LOSS_CEILING_CP = 100

_REPO_ROOT = Path(__file__).resolve().parents[2]
OPENING_BOOK_PATH = _REPO_ROOT / "data" / "reference" / "opening_book.json"


def to_cp_value(cp: float | None, mate: int | None) -> float:
    """Reproduce reviewEngine.ts's toCpValue() mate-score scaling."""
    if mate is not None:
        if mate > 0:
            return MATE_SENTINEL - mate * 10
        return -MATE_SENTINEL - mate * 10
    return float(cp) if cp is not None else 0.0


def win_percent(cp: float) -> float:
    """Reproduce the live app's Lichess-style win-percent transform."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


@lru_cache(maxsize=1)
def _load_opening_book() -> dict[str, list[str]]:
    with OPENING_BOOK_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _position_key(fen: str) -> str:
    return " ".join(fen.split(" ")[:4])


def is_opening_theory_candidate(fen_before: str, uci: str) -> bool:
    """
    Corpus-frequency heuristic, not verified theory: true when this
    position+move recurred across many distinct real games in Chesy's own
    corpus within the opening phase. See
    tools/dataset/build_opening_book.py and
    ml/specs/classification_policy.md.
    """
    moves = _load_opening_book().get(_position_key(fen_before))
    return uci in moves if moves else False


def classify(
    loss_cp: float,
    played_uci: str,
    best_uci: str | None,
    wp_before: float,
    wp_after: float,
    is_checkmate: bool,
    is_opening_theory_candidate: bool = False,
    missed_tactic_motif: str | None = None,
) -> str:
    """
    Same precedence as reviewEngine.ts's classify(), minus the
    Great/Brilliant branch (played-is-best always resolves to "best" here
    — no second-engine-line data available to detect "only good move" or
    a sound sacrifice). missed_tactic_motif should be one of
    "missed_mate"/"fork"/"pin"/"skewer"/None, matching the `motif` field
    already produced by dataset/src/motifs.py for engine-analyzed rows.
    """
    if is_checkmate:
        return "best"

    # A missed forced mate overrides the numeric ladder entirely.
    if missed_tactic_motif == "missed_mate":
        return "miss"

    # A common-in-our-corpus opening move never gets a Best badge, even
    # when it's also the engine's top choice.
    if is_opening_theory_candidate and loss_cp < BOOK_LOSS_CEILING_CP:
        return "book"

    if best_uci is not None:
        if played_uci == best_uci:
            return "best"
    elif loss_cp < 5:
        # Dataset-only fallback: best_uci is unknown for most rows (the
        # extractor only searches for it on inaccuracy-or-worse-tier
        # moves, to control engine cost — see NEEDS_ENGINE in
        # dataset/src/extractor.py). Without it we can't check literal
        # move-equality like the live app always can, so a small-loss
        # proxy stands in. Documented in
        # ml/specs/classification_policy.md; the live app never hits this
        # branch since it always has a best move from the engine.
        return "best"

    wp_drop = max(0.0, wp_before - wp_after)

    # If mover is overwhelmingly winning (>95%) and stays winning (>90%),
    # don't label as blunder.
    if wp_before > 95 and wp_after > 90:
        if loss_cp < 50:
            return "excellent"
        return "good"

    if wp_drop < 5.0 and loss_cp < 50:
        severity = "excellent"
    elif wp_drop < 10.0 and loss_cp < 100:
        severity = "good"
    elif wp_drop < 18.0 and loss_cp < 180:
        severity = "inaccuracy"
    elif wp_drop < 30.0 and loss_cp < 320:
        severity = "mistake"
    else:
        severity = "blunder"

    # A mistake/blunder that specifically forfeits a tactical win (rather
    # than just a generic bad move) is Miss instead. Only detectable on
    # rows where motif analysis actually ran — see
    # ml/specs/classification_policy.md.
    if severity in ("mistake", "blunder") and missed_tactic_motif in ("fork", "pin", "skewer"):
        return "miss"

    return severity


MISSED_TACTIC_MOTIFS = {"missed_mate", "fork", "pin", "skewer"}


@dataclass
class RowClassification:
    classification: str
    is_checkmate: bool
    loss_cp: float


def classify_row(row: dict) -> RowClassification:
    """
    Full row -> classification pipeline, shared by every tool that
    re-derives a classification from an already-written dataset row
    (tools/dataset/reclassify.py, tools/review_contract/
    compare_classification_contract.py, data/audit/duplication_audit.py).
    extractor.py builds rows incrementally instead and calls classify()
    directly, since it doesn't have a finished row to read fields from
    yet.
    """
    fen = row["fen"]
    played_uci = row["played_uci"]
    is_white = row["color"] == "white"

    board = chess.Board(fen)
    board.push_uci(played_uci)
    is_checkmate = board.is_checkmate()

    cp_before = to_cp_value(row.get("eval_before_cp"), row.get("eval_before_mate"))
    cp_after = to_cp_value(row.get("eval_after_cp"), row.get("eval_after_mate"))
    raw_delta = (cp_before - cp_after) if is_white else (cp_after - cp_before)
    loss_cp = max(0.0, float(raw_delta))

    wp_before = win_percent(cp_before) if is_white else 100 - win_percent(cp_before)
    wp_after = win_percent(cp_after) if is_white else 100 - win_percent(cp_after)

    is_theory = is_opening_theory_candidate(fen, played_uci)

    motif = row.get("motif", "none")
    missed_tactic_motif = motif if motif in MISSED_TACTIC_MOTIFS else None

    label = classify(
        loss_cp,
        played_uci,
        row.get("best_move_uci"),
        wp_before,
        wp_after,
        is_checkmate,
        is_theory,
        missed_tactic_motif,
    )
    return RowClassification(classification=label, is_checkmate=is_checkmate, loss_cp=loss_cp)
