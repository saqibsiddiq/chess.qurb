"""Deterministic, template-based explanations.

Same spirit as the app's Phase 4 templates, kept here so the dataset and
the live app never describe the same situation two different ways. This
stays rule-based on purpose — Phase 5 is about proving the data pipeline
(schema, classification, motif tagging) is correct, not about prose
quality. Swapping this function's output for a teacher-LLM-generated
explanation, conditioned on the same structured fields, is the natural
next step before training a model on this data (see the note at the
bottom of the README) — a model trained to imitate fixed templates
would just learn to reproduce the templates.
"""
from __future__ import annotations


def build_explanation(
    classification: str,
    motif: str,
    detail: dict,
    played_san: str,
    best_move_san: str | None,
    loss_cp: float,
    variant: int = 0,
) -> str:
    header = classification.upper()
    pawns = round(loss_cp / 100, 2)

    if motif == "mate":
        bodies = [
            f"The move {played_san} delivered immediate checkmate.",
            f"{played_san} ends the game at once: checkmate.",
            f"You finished the game with {played_san}, a checkmate.",
        ]
        body = bodies[variant % len(bodies)]

    elif motif == "missed_mate":
        suffix = f" with {best_move_san}" if best_move_san else ""
        bodies = [
            f"You had a forced mate available{suffix} and played something else instead.",
            f"Mate was available{suffix}, but this opportunity was missed.",
            f"The position contained a forced finish{suffix}; your move let it go.",
        ]
        body = bodies[variant % len(bodies)]

    elif motif == "allowed_mate":
        bodies = [
            f"You played {played_san}, allowing the opponent a forced mate.",
            f"After {played_san}, the opponent has a forced checkmate.",
            f"{played_san} opened the door to an unavoidable mate against you.",
        ]
        body = bodies[variant % len(bodies)]

    elif motif == "hanging_piece":
        piece = detail.get("piece", "piece")
        square = detail.get("square", "?")
        bodies = [
            f"You played {played_san}, dropping about {pawns} pawns. Your {piece} on {square} became attacked and undefended.",
            f"The move {played_san} left your {piece} on {square} hanging, costing about {pawns} pawns.",
            f"After {played_san}, the {piece} on {square} has no safe defense and can be won.",
        ]
        body = bodies[variant % len(bodies)]

    elif motif == "fork":
        raw_targets = detail.get("targets", [])
        target_names = [
            f"the {target.get('piece', 'piece')} on {target.get('square', '?')}"
            if isinstance(target, dict)
            else str(target)
            for target in raw_targets
        ]
        targets = (
            " and ".join(target_names)
            if len(target_names) == 2
            else ", ".join(target_names)
        ) or "multiple pieces"
        if best_move_san:
            bodies = [
                f"You played {played_san}, dropping about {pawns} pawns. The engine's move {best_move_san} forks {targets}.",
                f"Instead of {played_san}, {best_move_san} would hit two targets at once: {targets}.",
                f"The missed idea was {best_move_san}: a fork against {targets}.",
            ]
            body = bodies[variant % len(bodies)]
        else:
            body = f"You played {played_san}, dropping about {pawns} pawns, missing a fork on {targets}."

    elif motif == "pin":
        # detail describes what the ENGINE's move would have pinned (an
        # opponent piece), not something that happened to the mover's own
        # piece — this is a missed opportunity, same framing as "fork"
        # above and app/src/lib/explanations.ts's "Missed pin".
        piece = detail.get("piece", "piece")
        target = detail.get("target", "the piece behind it")
        if best_move_san:
            body = (
                f"The engine's move {best_move_san} would have pinned the {piece} to the {target}; "
                f"{played_san} let it move freely instead."
            )
        else:
            body = f"{played_san} missed a pin on the {piece}, which stays free to move."

    elif motif == "skewer":
        # Same framing note as "pin" above: this describes the engine's
        # missed move, not a threat against the mover.
        front = detail.get("front", "king")
        behind = detail.get("behind", "a valuable piece")
        if best_move_san:
            body = (
                f"The engine's move {best_move_san} would have skewered the {front}, winning the {behind} "
                f"behind it; {played_san} left both pieces safe."
            )
        else:
            body = f"{played_san} missed a skewer that would have won the {behind} behind the {front}."

    elif motif == "discovered_attack":
        target = detail.get("target", "a valuable piece")
        body = f"{played_san} opened a line onto {target}, creating a discovered attack."

    elif motif == "back_rank":
        body = f"{played_san} left the back rank vulnerable: the king has too little room to escape."

    elif classification == "book":
        bodies = [
            f"{played_san} follows common opening play at this stage of the game.",
            f"{played_san} matches how this position is often handled in practice.",
            f"{played_san} keeps to well-trodden opening ground here.",
        ]
        body = bodies[variant % len(bodies)]

    elif classification in ("best", "excellent", "good"):
        if pawns <= 0:
            body = f"{played_san} holds the position well."
        else:
            body = f"{played_san} was a reasonable choice, giving up only about {pawns} pawns."

    else:
        body = (
            f"No single tactical motif was detected. "
            f"The position became {pawns} pawns worse after {played_san}."
        )
        if best_move_san:
            body += f" The engine preferred {best_move_san}."

    return f"{header}\n\n{body}"
