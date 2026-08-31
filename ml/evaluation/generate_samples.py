#!/usr/bin/env python3
"""Loads the fine-tuned LoRA adapter and generates explanations for a
handful of held-out validation examples, printing them alongside the
real target and the source facts so quality can be checked by eye —
low training loss alone doesn't confirm the output is good.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"


def load_jsonl(path: Path) -> list[dict]:
    with path.open() as f:
        return [json.loads(line) for line in f]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", type=Path, default=Path("ml/models/chesy-slm-v1/final_adapter"))
    ap.add_argument("--val", type=Path, default=Path("ml/data/preparation/sft_val.jsonl"))
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--max-new-tokens", type=int, default=80)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    print(f"Loading base model {BASE_MODEL_ID} + adapter {args.adapter}...")
    tokenizer = AutoTokenizer.from_pretrained(str(args.adapter))
    base = AutoModelForCausalLM.from_pretrained(BASE_MODEL_ID, dtype=torch.float32)
    model = PeftModel.from_pretrained(base, str(args.adapter))
    model.eval()

    val_rows = load_jsonl(args.val)
    import random

    random.Random(args.seed).shuffle(val_rows)
    sample = val_rows[: args.n]

    for i, row in enumerate(sample, 1):
        messages = [
            {"role": "system", "content": row["system"]},
            {"role": "user", "content": row["user"]},
        ]
        prompt_text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        inputs = tokenizer(prompt_text, return_tensors="pt")
        with torch.no_grad():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        generated = tokenizer.decode(output_ids[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True).strip()

        print(f"\n=== [{i}/{len(sample)}] id={row['id']} ===")
        print(f"FACTS: {row['user'][:300]}")
        print(f"REAL TARGET:  {row['target']}")
        print(f"GENERATED:    {generated}")


if __name__ == "__main__":
    main()
