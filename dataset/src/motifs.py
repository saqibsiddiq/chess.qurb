"""Conservative tactical-motif heuristics for Chesy dataset rows."""

from __future__ import annotations

from dataclasses import dataclass, field

import chess


BAD_CLASSIFICATIONS = {
    "inaccuracy",
    "mistake",
    "blunder",
}


@dataclass
class MotifResult:
    motif: str = "none"
    detail: dict = field(default_factory=dict)


# ---------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------


def _directions(
    piece_type: chess.PieceType,
) -> list[tuple[int, int]]:
    diagonal = [
        (1, 1),
        (1, -1),
        (-1, 1),
        (-1, -1),
    ]

    straight = [
        (1, 0),
        (-1, 0),
        (0, 1),
        (0, -1),
    ]

    if piece_type == chess.BISHOP:
        return diagonal

    if piece_type == chess.ROOK:
        return straight

    if piece_type == chess.QUEEN:
        return diagonal + straight

    return []


def _next_piece(
    board: chess.Board,
    square: chess.Square,
    direction: tuple[int, int],
):
    file = (
        chess.square_file(square)
        + direction[0]
    )

    rank = (
        chess.square_rank(square)
        + direction[1]
    )

    while (
        0 <= file < 8
        and 0 <= rank < 8
    ):
        next_square = chess.square(
            file,
            rank,
        )

        piece = board.piece_at(
            next_square
        )

        if piece is not None:
            return (
                next_square,
                piece,
            )

        file += direction[0]
        rank += direction[1]

    return None


# ---------------------------------------------------------------------
# Fork
# ---------------------------------------------------------------------


def _nonpawn_targets(
    board: chess.Board,
    square: chess.Square,
    color: chess.Color,
) -> dict[
    chess.Square,
    chess.Piece,
]:
    targets = {}

    for target_square in board.attacks(
        square
    ):
        target = board.piece_at(
            target_square
        )

        if (
            target is not None
            and target.color != color
            and target.piece_type != chess.PAWN
        ):
            targets[target_square] = target

    return targets


def _fork(
    board_before: chess.Board,
    board_after: chess.Board,
    move: chess.Move,
    color: chess.Color,
) -> MotifResult | None:
    """
    Detect a double attack created by the candidate move.
    """

    piece = board_after.piece_at(
        move.to_square
    )

    if piece is None:
        return None

    if piece.color != color:
        return None

    after_targets = _nonpawn_targets(
        board_after,
        move.to_square,
        color,
    )

    if len(after_targets) < 2:
        return None

    # What the moved piece attacked
    # from its source square.
    before_targets = _nonpawn_targets(
        board_before,
        move.from_square,
        color,
    )

    new_targets = (
        set(after_targets)
        - set(before_targets)
    )

    if not new_targets:
        return None

    return MotifResult(
        "fork",
        {
            "piece": chess.piece_name(
                piece.piece_type
            ),
            "targets": [
                {
                    "piece": chess.piece_name(
                        target.piece_type
                    ),
                    "square": chess.square_name(
                        square
                    ),
                }
                for square, target
                in after_targets.items()
            ],
            "new_targets": [
                chess.square_name(square)
                for square in sorted(
                    new_targets
                )
            ],
        },
    )


# ---------------------------------------------------------------------
# Pin / skewer
# ---------------------------------------------------------------------


def _line_motif(
    board: chess.Board,
    start: chess.Square,
    color: chess.Color,
    motif: str,
) -> MotifResult | None:
    """
    Find a pin/skewer created by a slider on `start`.

    Geometry:
        our slider -> enemy front piece -> enemy target
    """

    attacker = board.piece_at(start)

    if attacker is None:
        return None

    if attacker.color != color:
        return None

    if attacker.piece_type not in (
        chess.BISHOP,
        chess.ROOK,
        chess.QUEEN,
    ):
        return None

    enemy = not color

    for direction in _directions(
        attacker.piece_type
    ):
        front_result = _next_piece(
            board,
            start,
            direction,
        )

        if front_result is None:
            continue

        front_square, front = (
            front_result
        )

        if front.color != enemy:
            continue

        behind_result = _next_piece(
            board,
            front_square,
            direction,
        )

        if behind_result is None:
            continue

        behind_square, behind = (
            behind_result
        )

        if behind.color != enemy:
            continue

        if (
            motif == "pin"
            and behind.piece_type
            in (
                chess.KING,
                chess.QUEEN,
                chess.ROOK,
            )
        ):
            return MotifResult(
                "pin",
                {
                    "piece": chess.piece_name(
                        front.piece_type
                    ),
                    "square": chess.square_name(
                        front_square
                    ),
                    "target": chess.piece_name(
                        behind.piece_type
                    ),
                    "target_square":
                        chess.square_name(
                            behind_square
                        ),
                },
            )

        if (
            motif == "skewer"
            and front.piece_type == chess.KING
            and behind.piece_type != chess.PAWN
        ):
            return MotifResult(
                "skewer",
                {
                    "front": "king",
                    "front_square":
                        chess.square_name(
                            front_square
                        ),
                    "behind":
                        chess.piece_name(
                            behind.piece_type
                        ),
                    "behind_square":
                        chess.square_name(
                            behind_square
                        ),
                },
            )

    return None


# ---------------------------------------------------------------------
# Hanging piece
# ---------------------------------------------------------------------


def _hanging_piece(
    board_before: chess.Board,
    board_after: chess.Board,
    move: chess.Move,
    color: chess.Color,
) -> MotifResult | None:
    """
    Detect a piece that becomes newly attacked and has no defenders.
    """

    enemy = not color

    for square in chess.SQUARES:
        piece = board_after.piece_at(
            square
        )

        if piece is None:
            continue

        if piece.color != color:
            continue

        if piece.piece_type == chess.KING:
            continue

        attackers_after = (
            board_after.attackers(
                enemy,
                square,
            )
        )

        defenders_after = (
            board_after.attackers(
                color,
                square,
            )
        )

        if not attackers_after:
            continue

        if defenders_after:
            continue

        attackers_before = (
            board_before.attackers(
                enemy,
                square,
            )
        )

        defenders_before = (
            board_before.attackers(
                color,
                square,
            )
        )

        was_hanging = (
            bool(attackers_before)
            and not defenders_before
        )

        if was_hanging:
            continue

        newly_attacked = bool(
            set(attackers_after)
            - set(attackers_before)
        )

        newly_undefended = bool(
            defenders_before
        )

        moved_to = move.to_square

        if (
            square != moved_to
            and not newly_attacked
            and not newly_undefended
        ):
            continue

        attacker_square = next(
            iter(attackers_after)
        )

        return MotifResult(
            "hanging_piece",
            {
                "piece": chess.piece_name(
                    piece.piece_type
                ),
                "square": chess.square_name(
                    square
                ),
                "attacker_square":
                    chess.square_name(
                        attacker_square
                    ),
            },
        )

    return None


# ---------------------------------------------------------------------
# Discovered attack
# ---------------------------------------------------------------------


def _discovered_attack(
    board_before: chess.Board,
    board_after: chess.Board,
    move: chess.Move,
    color: chess.Color,
) -> MotifResult | None:
    """
    Detect a bishop/rook/queen attack that
    appeared only because of the played move.
    """

    enemy = not color

    for square in chess.SQUARES:
        target = board_after.piece_at(
            square
        )

        if target is None:
            continue

        if target.color != enemy:
            continue

        if target.piece_type == chess.PAWN:
            continue

        before_attackers = (
            board_before.attackers(
                color,
                square,
            )
        )

        after_attackers = (
            board_after.attackers(
                color,
                square,
            )
        )

        new_attackers = (
            after_attackers
            - before_attackers
        )

        # The moved piece itself isn't
        # the discovered attacker.
        new_attackers.discard(
            move.to_square
        )

        for attacker_square in new_attackers:
            attacker = board_after.piece_at(
                attacker_square
            )

            if attacker is None:
                continue

            if attacker.piece_type not in (
                chess.BISHOP,
                chess.ROOK,
                chess.QUEEN,
            ):
                continue

            return MotifResult(
                "discovered_attack",
                {
                    "target":
                        chess.piece_name(
                            target.piece_type
                        ),
                    "target_square":
                        chess.square_name(
                            square
                        ),
                    "attacker":
                        chess.piece_name(
                            attacker.piece_type
                        ),
                    "attacker_square":
                        chess.square_name(
                            attacker_square
                        ),
                },
            )

    return None


# ---------------------------------------------------------------------
# Back rank
# ---------------------------------------------------------------------


def _back_rank(
    board: chess.Board,
    color: chess.Color,
) -> MotifResult | None:
    """
    Conservative back-rank detection.

    We only label a position when:
      - the enemy king is on rank 1/8
      - the enemy king is in check
      - the checker is a rook or queen
      - the king has no legal king move
      - at least three adjacent squares contain
        friendly pieces

    This intentionally prefers false negatives
    over false positives.
    """

    enemy = not color

    king_square = board.king(
        enemy
    )

    if king_square is None:
        return None

    if chess.square_rank(
        king_square
    ) not in (0, 7):
        return None

    if not board.is_check():
        return None

    checkers = board.attackers(
        color,
        king_square,
    )

    has_rook_or_queen_checker = any(
        (
            piece := board.piece_at(
                checker_square
            )
        )
        and piece.piece_type
        in (
            chess.ROOK,
            chess.QUEEN,
        )
        for checker_square in checkers
    )

    if not has_rook_or_queen_checker:
        return None

    king_has_move = any(
        move.from_square
        == king_square
        for move in board.legal_moves
    )

    if king_has_move:
        return None

    king_file = chess.square_file(
        king_square
    )

    king_rank = chess.square_rank(
        king_square
    )

    blockers = 0

    for df in (-1, 0, 1):
        for dr in (-1, 0, 1):
            if df == 0 and dr == 0:
                continue

            file = king_file + df
            rank = king_rank + dr

            if not (
                0 <= file < 8
                and 0 <= rank < 8
            ):
                continue

            square = chess.square(
                file,
                rank,
            )

            piece = board.piece_at(
                square
            )

            if (
                piece is not None
                and piece.color == enemy
            ):
                blockers += 1

    if blockers < 3:
        return None

    return MotifResult(
        "back_rank",
        {
            "square":
                chess.square_name(
                    king_square
                ),
            "blocked_neighbors":
                blockers,
        },
    )


# ---------------------------------------------------------------------
# Move simulation
# ---------------------------------------------------------------------


def _simulate_uci(
    board: chess.Board,
    uci: str | None,
) -> tuple[chess.Board, chess.Move] | None:
    if not uci:
        return None

    try:
        move = chess.Move.from_uci(
            uci
        )

        if move not in board.legal_moves:
            return None

        board.push(move)

        return board, move

    except ValueError:
        return None


# ---------------------------------------------------------------------
# Main detector
# ---------------------------------------------------------------------


def detect_motif(
    board_before: chess.Board,
    board_after: chess.Board,
    move: chess.Move,
    mover_is_white: bool,
    eval_before_mate: int | None,
    eval_after_mate: int | None,
    best_move_uci: str | None = None,
    classification: str = "blunder",
) -> MotifResult:
    """
    Match the frontend's explanation semantics.

    Played-move consequences:
        hanging_piece
        discovered_attack
        back_rank

    Missed best-move ideas:
        fork
        pin
        skewer
    """

    mover_color = (
        chess.WHITE
        if mover_is_white
        else chess.BLACK
    )

    bad_move = (
        classification
        in BAD_CLASSIFICATIONS
    )

    # -------------------------------------------------------------
    # Mate
    # -------------------------------------------------------------

    had_mate = (
        eval_before_mate is not None
        and (
            (
                mover_is_white
                and eval_before_mate > 0
            )
            or (
                not mover_is_white
                and eval_before_mate < 0
            )
        )
    )

    still_mate = (
        eval_after_mate is not None
        and (
            (
                mover_is_white
                and eval_after_mate > 0
            )
            or (
                not mover_is_white
                and eval_after_mate < 0
            )
        )
    )

    opponent_mate = (
        eval_after_mate is not None
        and (
            (
                mover_is_white
                and eval_after_mate < 0
            )
            or (
                not mover_is_white
                and eval_after_mate > 0
            )
        )
    )

    if had_mate and not still_mate:
        return MotifResult(
            "missed_mate"
        )

    if opponent_mate:
        return MotifResult(
            "allowed_mate"
        )

    # Don't assign ordinary tactical
    # explanations to good moves.
    if not bad_move:
        return MotifResult()

    # -------------------------------------------------------------
    # 1. Played-move consequence
    # -------------------------------------------------------------

    result = _hanging_piece(
        board_before,
        board_after,
        move,
        mover_color,
    )

    if result:
        return result

    # -------------------------------------------------------------
    # 2. Missed best-move idea
    # -------------------------------------------------------------

    simulated = _simulate_uci(
        board_before.copy(),
        best_move_uci,
    )

    if simulated is not None:
        best_board, best_move = simulated

        result = _fork(
            board_before,
            best_board,
            best_move,
            mover_color,
        )

        if result:
            return result

        for motif_name in (
            "pin",
            "skewer",
        ):
            result = _line_motif(
                best_board,
                best_move.to_square,
                mover_color,
                motif_name,
            )

            if result:
                return result

    # -------------------------------------------------------------
    # 3. Played-move discovered attack
    # -------------------------------------------------------------

    result = _discovered_attack(
        board_before,
        board_after,
        move,
        mover_color,
    )

    if result:
        return result

    # -------------------------------------------------------------
    # 4. Back rank
    # -------------------------------------------------------------

    result = _back_rank(
        board_after,
        mover_color,
    )

    if result:
        return result

    return MotifResult()