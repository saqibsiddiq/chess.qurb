#!/usr/bin/env python3
"""Full evaluation pass: generates an explanation for every validation
row via the fine-tuned adapter, then checks each one two ways —

1. The same fact-grounding checks used on the teacher-generated training
   data itself (required motif squares present, check/checkmate claims
   backed by real data) — reused directly from verify_teacher_output.py
   rather than re-implemented.
2. A numeric-consistency check that isn't in that verifier: any "N.NN
   pawns" figure mentioned in the generated text must match the row's
   actual loss_cp/100 (within rounding tolerance). This was added
   specifically because a 10-sample spot check found the model getting
   this wrong by exactly 10x on an unusually large loss value — a
   failure mode the square/motif checks can't see at all.

Low training loss doesn't confirm output quality; this does, or at
least gives a real, countable error rate instead of a guess from a
handful of samples.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data" / "phase6a_pipeline"))
from verify_teacher_output import verify_row  # noqa: E402

BASE_MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"
PAWNS_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*pawns?\b", re.IGNORECASE)


def load_jsonl(path: Path) -> list[dict]:
    with path.open() as f:
        return [json.loads(line) for line in f]


def numeric_problems(input_facts: dict, explanation: str) -> list[str]:
    loss_cp = input_facts.get("loss_cp")
    if loss_cp is None:
        return []
    expected_pawns = round(loss_cp / 100, 2)
    problems = []
    for match in PAWNS_RE.finditer(explanation):
        stated = float(match.group(1))
        # A generous relative+absolute tolerance: rounding/phrasing
        # variation ("about 1.6 pawns" vs "1.61") is fine, an outright
        # unit/decimal error (the 10x bug this script exists to catch)
        # is not.
        if abs(stated - expected_pawns) > max(0.15, expected_pawns * 0.15):
            problems.append(
                f"stated {stated} pawns but loss_cp={loss_cp} implies {expected_pawns} pawns"
            )
    return problems


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", type=Path, default=Path("ml/models/chesy-slm-v1/final_adapter"))
    ap.add_argument("--val", type=Path, default=Path("ml/data/preparation/sft_val.jsonl"))
    ap.add_argument("--sft-source", type=Path, default=Path("data/phase6/sft_10k_claude.jsonl"),
                     help="Where the structured `input` facts live (sft_val.jsonl only keeps prompt text)")
    ap.add_argument("--max-new-tokens", type=int, default=60)
    ap.add_argument("--batch-size", type=int, default=16,
                     help="Rows generated per model.generate() call — batching is the real speedup on CPU, not just a smaller cap")
    ap.add_argument("--limit", type=int, default=0, help="Cap rows for a quick test; 0 = all")
    ap.add_argument("--out", type=Path, default=Path("ml/evaluation/eval_results.jsonl"))
    args = ap.parse_args()

    print(f"Loading base model {BASE_MODEL_ID} + adapter {args.adapter}...")
    tokenizer = AutoTokenizer.from_pretrained(str(args.adapter))
    # Left-padding: every sequence in a batch must line up on the *right*
    # edge for causal-LM generation to continue correctly, so shorter
    # prompts get padded on the left instead of the more common
    # right-padding used for training.
    tokenizer.padding_side = "left"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    base = AutoModelForCausalLM.from_pretrained(BASE_MODEL_ID, dtype=torch.float32)
    model = PeftModel.from_pretrained(base, str(args.adapter))
    model.eval()

    print(f"Loading facts lookup from {args.sft_source}...")
    facts_by_id = {row["id"]: row["input"] for row in load_jsonl(args.sft_source)}

    val_rows = load_jsonl(args.val)
    if args.limit:
        val_rows = val_rows[: args.limit]
    val_rows = [r for r in val_rows if facts_by_id.get(r["id"]) is not None]
    n_no_facts = 0  # filtered above; kept as a named var for the summary print
    print(f"Evaluating {len(val_rows)} validation rows in batches of {args.batch_size}...")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    n_grounding_clean = n_numeric_clean = n_both_clean = 0
    results = []

    for batch_start in range(0, len(val_rows), args.batch_size):
        batch = val_rows[batch_start : batch_start + args.batch_size]
        prompts = [
            tokenizer.apply_chat_template(
                [{"role": "system", "content": r["system"]}, {"role": "user", "content": r["user"]}],
                add_generation_prompt=True,
                tokenize=False,
            )
            for r in batch
        ]
        inputs = tokenizer(prompts, return_tensors="pt", padding=True)
        with torch.no_grad():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        # Left-padded, so every sequence's generation starts at the same
        # column — one uniform slice works for the whole batch.
        new_tokens = output_ids[:, inputs["input_ids"].shape[1] :]
        generations = [tokenizer.decode(t, skip_special_tokens=True).strip() for t in new_tokens]

        for row, generated in zip(batch, generations):
            input_facts = facts_by_id[row["id"]]
            grounding_problems = verify_row(input_facts, generated)
            num_problems = numeric_problems(input_facts, generated)

            if not grounding_problems:
                n_grounding_clean += 1
            if not num_problems:
                n_numeric_clean += 1
            if not grounding_problems and not num_problems:
                n_both_clean += 1

            results.append({
                "id": row["id"],
                "target": row["target"],
                "generated": generated,
                "grounding_problems": grounding_problems,
                "numeric_problems": num_problems,
            })

        done = batch_start + len(batch)
        print(f"  [{done}/{len(val_rows)}] clean_so_far={n_both_clean}/{done}", flush=True)

    with args.out.open("w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    n_evaluated = len(val_rows) - n_no_facts
    print("\n=== EVAL SUMMARY ===")
    print(f"Evaluated:               {n_evaluated}")
    print(f"Grounding-clean:         {n_grounding_clean} ({n_grounding_clean/max(1,n_evaluated):.1%})")
    print(f"Numeric-clean:           {n_numeric_clean} ({n_numeric_clean/max(1,n_evaluated):.1%})")
    print(f"Fully clean (both):      {n_both_clean} ({n_both_clean/max(1,n_evaluated):.1%})")
    print(f"Skipped (no source facts): {n_no_facts}")
    print(f"Full results: {args.out}")


if __name__ == "__main__":
    main()
