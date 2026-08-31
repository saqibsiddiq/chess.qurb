#!/usr/bin/env python3
"""Joins the verified teacher explanations back onto their original
prompts and splits into train/validation sets ready for fine-tuning.

Prompt text isn't duplicated into sft_10k_claude.jsonl (that file only
has the structured `input` facts + `target`), so this re-joins by `id`
against teacher_pilot_10k.jsonl, which still has the exact `prompt`
string every explanation was actually generated against — training
must see the identical instruction format the model will get at
inference time, not a reconstruction of it.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

# The prompt's own template (see teacher_pilot_10k.jsonl generation)
# always separates general instructions from the per-position facts
# with a blank line before "FEN:" — split there so the instructions
# become the chat template's system turn and the facts become the
# user turn, rather than dumping everything into one long user turn.
SPLIT_MARKER = "\nFEN:"


def split_prompt(prompt: str) -> tuple[str, str]:
    idx = prompt.index(SPLIT_MARKER)
    system = prompt[:idx].strip()
    user = prompt[idx + 1 :].strip()
    return system, user


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=Path("data/phase6/teacher_pilot_10k.jsonl"))
    ap.add_argument("--sft", type=Path, default=Path("data/phase6/sft_10k_claude.jsonl"))
    ap.add_argument("--out-dir", type=Path, default=Path("ml/data/preparation"))
    ap.add_argument("--val-fraction", type=float, default=0.03)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    prompts_by_id: dict[str, str] = {}
    with args.source.open() as f:
        for line in f:
            row = json.loads(line)
            prompts_by_id[row["id"]] = row["prompt"]

    examples = []
    missing = 0
    with args.sft.open() as f:
        for line in f:
            row = json.loads(line)
            prompt = prompts_by_id.get(row["id"])
            if prompt is None:
                missing += 1
                continue
            system, user = split_prompt(prompt)
            examples.append({"id": row["id"], "system": system, "user": user, "target": row["target"]})

    if missing:
        print(f"WARNING: {missing} sft rows had no matching prompt, skipped")

    random.Random(args.seed).shuffle(examples)
    n_val = max(1, int(len(examples) * args.val_fraction))
    val, train = examples[:n_val], examples[n_val:]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train", train), ("val", val)):
        out_path = args.out_dir / f"sft_{name}.jsonl"
        with out_path.open("w") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{name}: {len(rows)} rows -> {out_path}")


if __name__ == "__main__":
    main()
