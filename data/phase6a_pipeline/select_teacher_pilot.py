#!/usr/bin/env python3
"""Select a 10,000-example stratified teacher-labeling pilot from train.jsonl."""

from __future__ import annotations
import argparse, json, random
from collections import Counter
from pathlib import Path

QUOTAS = {
    "rare_edge": 1000,
    "blunder": 2500,
    "mistake": 2000,
    "miss": 1000,
    "inaccuracy": 1500,
    "other_motif": 1000,
    "good_excellent": 500,
    "best": 500,
}
RARE_MOTIFS = {"back_rank", "skewer", "mate", "missed_mate", "allowed_mate"}
ORDER = tuple(QUOTAS)


def bucket(rec):
    x = rec["input"]
    motif, cls = x["motif"], x["classification"]
    if motif in RARE_MOTIFS:
        return "rare_edge"
    if cls == "miss":
        # Missed a forced mate/fork/pin/skewer — specifically the category
        # this pilot most needs good explanations for, so it gets its own
        # bucket even though its motif may already be a RARE_MOTIFS value
        # (missed_mate/skewer) — those get caught above, everything else
        # (fork/pin) lands here instead of the generic other_motif bucket.
        return "miss"
    if cls == "blunder":
        return "blunder"
    if cls == "mistake":
        return "mistake"
    if cls == "inaccuracy":
        return "inaccuracy"
    if motif != "none":
        return "other_motif"
    if cls in {"good", "excellent", "book"}:
        return "good_excellent"
    if cls == "best":
        return "best"
    return None


def prompt(x):
    return (
        "You are a chess coach explaining one move to a human player. "
        "Use only the supplied facts. Do not invent tactical claims or variations. "
        "Explain the key chess idea, why the move was good or bad, and what the "
        "best move improves when one is supplied. Be concise and instructional.\n\n"
        f"FEN: {x['fen']}\n"
        f"Color: {x['color']}\n"
        f"Move number: {x['move_number']}\n"
        f"Played move: {x['played_move']}\n"
        f"Best move: {x['best_move'] or 'not provided'}\n"
        f"Evaluation before (cp): {x['eval_before_cp']}\n"
        f"Evaluation before (mate): {x['eval_before_mate']}\n"
        f"Evaluation after (cp): {x['eval_after_cp']}\n"
        f"Evaluation after (mate): {x['eval_after_mate']}\n"
        f"Loss (cp): {x['loss_cp']}\n"
        f"Classification: {x['classification']}\n"
        f"Motif: {x['motif']}\n"
        f"Motif detail: {json.dumps(x['motif_detail'], ensure_ascii=False, sort_keys=True)}"
    )


def add(reservoir, seen, key, rec, quota, rng):
    seen[key] += 1
    b = reservoir[key]
    if len(b) < quota:
        b.append(rec)
        return
    j = rng.randrange(seen[key])
    if j < quota:
        b[j] = rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/phase6/train.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/phase6/teacher_pilot_10k.jsonl"))
    ap.add_argument("--report", type=Path, default=Path("data/phase6/teacher_pilot_10k_report.json"))
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Input does not exist: {args.input}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    reservoir = {k: [] for k in ORDER}
    seen = Counter()
    scanned = invalid = 0

    with args.input.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            scanned += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                invalid += 1
                continue
            if not isinstance(rec.get("input"), dict):
                invalid += 1
                continue
            key = bucket(rec)
            if key:
                add(reservoir, seen, key, rec, QUOTAS[key], rng)

            if scanned % 100000 == 0:
                held = sum(len(v) for v in reservoir.values())
                print(f"Rows scanned: {scanned:,} | pilot held: {held:,}", flush=True)

    selected = []
    counts = {}
    for key in ORDER:
        b = reservoir[key]
        rng.shuffle(b)
        counts[key] = len(b)
        for rec in b:
            x = rec["input"]
            selected.append({
                "id": rec["id"],
                "game_id": rec["game_id"],
                "bucket": key,
                "input": x,
                "prompt": prompt(x),
                "baseline_explanation": rec.get("baseline_explanation"),
            })
    rng.shuffle(selected)

    with args.output.open("w", encoding="utf-8") as out:
        for rec in selected:
            out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")

    report = {
        "version": 1,
        "seed": args.seed,
        "input": str(args.input.resolve()),
        "output": str(args.output.resolve()),
        "input_rows_scanned": scanned,
        "invalid_rows": invalid,
        "requested_quotas": QUOTAS,
        "available_by_bucket": dict(seen),
        "selected_by_bucket": counts,
        "selected_total": len(selected),
        "rare_edge_motifs": sorted(RARE_MOTIFS),
        "selection_rule": "reservoir sampling from train.jsonl only; rare_edge has priority",
    }
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== TEACHER PILOT ===")
    print(f"Input rows scanned: {scanned:,}")
    print(f"Invalid rows:       {invalid:,}")
    print(f"Pilot examples:     {len(selected):,}")
    for key in ORDER:
        print(f"  {key:16s} {counts[key]:5,d} / requested {QUOTAS[key]:,} / available {seen[key]:,}")
    print(f"\nWrote: {args.output}")
    print(f"Report: {args.report}")


if __name__ == "__main__":
    main()
