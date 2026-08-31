#!/usr/bin/env python3
"""LoRA fine-tunes Qwen3.5-0.8B on Chesy's verified 10k teacher-generation
dataset (ml/data/preparation/sft_{train,val}.jsonl) to produce the move-
explanation SLM.

Each example is formatted as a chat turn (system = the coaching
instructions, user = the position facts, assistant = the verified
explanation) using the base model's own chat template, so training sees
exactly the format inference will use. Loss is computed only on the
assistant turn — the system/user tokens are masked to -100 so the model
isn't penalized for "predicting" input it was only ever given, not asked
to generate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)

MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"


def load_jsonl(path: Path) -> list[dict]:
    with path.open() as f:
        return [json.loads(line) for line in f]


def build_example(tokenizer, row: dict, max_length: int) -> dict:
    system_msg = {"role": "system", "content": row["system"]}
    user_msg = {"role": "user", "content": row["user"]}

    # Tokenize the prompt (system+user, with the assistant turn opened)
    # once, then tokenize the target response as plain text and
    # concatenate directly — this guarantees prompt_ids is an exact
    # prefix of full_ids by construction, rather than hoping two
    # independent apply_chat_template() calls (with/without the
    # assistant turn) happen to tokenize identical shared text
    # identically, which chat templates aren't guaranteed to do.
    prompt_text = tokenizer.apply_chat_template(
        [system_msg, user_msg],
        add_generation_prompt=True,
        tokenize=False,
    )
    prompt_ids = tokenizer.encode(prompt_text, add_special_tokens=False)
    response_ids = tokenizer.encode(row["target"], add_special_tokens=False)
    eos_ids = [tokenizer.eos_token_id] if tokenizer.eos_token_id is not None else []
    full_ids = (prompt_ids + response_ids + eos_ids)[:max_length]

    labels = list(full_ids)
    prompt_len = min(len(prompt_ids), len(full_ids))
    for i in range(prompt_len):
        labels[i] = -100

    return {"input_ids": full_ids, "attention_mask": [1] * len(full_ids), "labels": labels}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, default=Path("ml/data/preparation/sft_train.jsonl"))
    ap.add_argument("--val", type=Path, default=Path("ml/data/preparation/sft_val.jsonl"))
    ap.add_argument("--output-dir", type=Path, default=Path("ml/models/chesy-slm-lora"))
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--limit", type=int, default=0, help="Cap train rows for a quick smoke test; 0 = all")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--per-device-batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--learning-rate", type=float, default=1e-4)
    ap.add_argument("--logging-steps", type=int, default=5)
    ap.add_argument("--model-id", type=str, default=MODEL_ID)
    args = ap.parse_args()

    torch.manual_seed(42)

    # Auto-detect: a real GPU has native bf16 tensor cores (Kaggle/Colab's
    # T4 etc.), so bf16 is a genuine speedup there. On CPU-only hardware
    # without AVX512-BF16/AMX, bf16 is emulated (upcast/compute/downcast)
    # and is slower than plain fp32, not faster — measured directly on
    # this machine (841s -> 25s for a smoke test came from switching to
    # fp32 + dropping gradient checkpointing, not from the model swap
    # alone). Gradient checkpointing similarly only earns its keep when
    # there's real memory pressure to trade compute against — a GPU with
    # limited VRAM benefits from it, this 15GB-RAM CPU box at 135M params
    # does not.
    use_cuda = torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda else torch.float32

    print(f"Loading tokenizer + model: {args.model_id} (device={'cuda' if use_cuda else 'cpu'}, dtype={dtype})")
    tokenizer = AutoTokenizer.from_pretrained(args.model_id)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model_id, dtype=dtype)
    if use_cuda:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print(f"Loading data: {args.train}, {args.val}")
    train_rows = load_jsonl(args.train)
    val_rows = load_jsonl(args.val)
    if args.limit:
        train_rows = train_rows[: args.limit]
        val_rows = val_rows[: max(1, args.limit // 10)]
    print(f"Using {len(train_rows)} train rows, {len(val_rows)} val rows")

    train_examples = [build_example(tokenizer, r, args.max_length) for r in train_rows]
    val_examples = [build_example(tokenizer, r, args.max_length) for r in val_rows]
    train_ds = Dataset.from_list(train_examples)
    val_ds = Dataset.from_list(val_examples)

    collator = DataCollatorForSeq2Seq(tokenizer, model=model, padding=True, label_pad_token_id=-100)

    training_args = TrainingArguments(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.per_device_batch_size,
        per_device_eval_batch_size=args.per_device_batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.learning_rate,
        logging_steps=args.logging_steps,
        eval_strategy="steps",
        eval_steps=max(1, args.logging_steps * 10),
        save_strategy="epoch",
        use_cpu=not use_cuda,
        bf16=use_cuda,
        report_to=[],
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=collator,
    )

    print("Starting training...")
    result = trainer.train()
    print(result)

    model.save_pretrained(str(args.output_dir / "final_adapter"))
    tokenizer.save_pretrained(str(args.output_dir / "final_adapter"))
    print(f"Saved LoRA adapter to {args.output_dir / 'final_adapter'}")


if __name__ == "__main__":
    main()
