#!/usr/bin/env python3
"""Deterministic post-generation correction: if the model's stated pawn
figure doesn't match the real loss_cp fact, replace just that clause
with a correct one computed directly from the facts — never trust the
model's own arithmetic/framing for something we already know for certain.

This is cheap (pure regex/string ops, no model inference) and runs
after every generation, both here for evaluation and eventually at
real app inference time. It only touches the specific clause that's
wrong; the rest of the model's generated prose (tactical explanation,
motif mentions, phrasing choices) is left untouched.
"""

from __future__ import annotations

import re

# Matches "giving up about 3.4 pawns" / "giving up only about 0.28 pawns"
# — the exact, consistent clause shape the fine-tuned model produces for
# every classification. Captures the leading "is a X" / "is Y" boundary
# implicitly by only replacing from "giving up" onward.
PAWNS_CLAUSE_RE = re.compile(
    r",?\s*giving up (?:only )?about [\d.]+ pawns?",
    re.IGNORECASE,
)


def correct_outcome_clause(input_facts: dict) -> str:
    """The deterministically-correct clause fragment for this position,
    matching the phrasing style the training data itself consistently
    uses for mate-involving rows (verified directly against real
    training targets, not guessed)."""
    after_mate = input_facts.get("eval_after_mate")
    before_mate = input_facts.get("eval_before_mate")
    loss_cp = input_facts.get("loss_cp")

    if after_mate is not None:
        if after_mate == 0:
            return " and delivers checkmate"
        color = "White" if after_mate > 0 else "Black"
        return f", which allows a forced mate in {abs(int(after_mate))} for {color}"
    if before_mate is not None:
        return f", which misses a forced mate in {abs(int(before_mate))}"
    if loss_cp is not None:
        pawns = round(loss_cp / 100, 2)
        return f", giving up about {pawns} pawns"
    return ""


def correct_explanation(input_facts: dict, generated: str) -> tuple[str, bool]:
    """Returns (possibly-corrected text, was_corrected). Only touches
    the pawns/mate clause — everything else in the generated text is
    left exactly as the model produced it."""
    if not PAWNS_CLAUSE_RE.search(generated):
        return generated, False

    correct_clause = correct_outcome_clause(input_facts)
    corrected = PAWNS_CLAUSE_RE.sub(correct_clause, generated, count=1)
    # Tidy up: the model's own clause always starts with a leading
    # ", " or " " that correct_outcome_clause already re-supplies —
    # collapse any doubled punctuation/whitespace left behind.
    corrected = re.sub(r"\s+,", ",", corrected)
    corrected = re.sub(r",\s*and\b", " and", corrected)
    return corrected, corrected != generated
