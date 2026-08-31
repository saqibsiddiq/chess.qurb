#!/usr/bin/env python3
"""Generate teacher explanations for a Chesy teacher-pilot file via the
Claude API.

Reads rows with a pre-built `prompt` field (see select_teacher_pilot.py's
prompt() / prepare_corpus.py's teacher_prompt()) and writes one
{"id", "explanation"} JSON object per line, matching
teacher_output_schema.json — the format merge_teacher_outputs.py expects.

This is deliberately a small, sequential trial runner (no concurrency,
minimal retry) — use --limit to keep early runs cheap while checking
output quality against baseline_explanation before spending on the full
pilot. Requires ANTHROPIC_API_KEY in the environment; never pass a key on
the command line or hardcode one here.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from anthropic import Anthropic, APIError

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_RETRIES = 3


def generate_one(client: Anthropic, model: str, prompt: str, max_tokens: int) -> str:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text.strip()
        except APIError as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(2 * attempt)
    raise RuntimeError(f"Failed after {MAX_RETRIES} attempts: {last_error}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/phase6/teacher_pilot_10k.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/phase6/teacher_output_trial.jsonl"))
    ap.add_argument("--limit", type=int, default=100, help="Number of rows to process; 0 means all.")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-tokens", type=int, default=250)
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "ANTHROPIC_API_KEY is not set in this environment. "
            "Set it with `set -Ux ANTHROPIC_API_KEY \"sk-ant-...\"` in a fish "
            "shell (or your shell's equivalent), open a new terminal, and try again."
        )

    if not args.input.exists():
        raise SystemExit(f"Input not found: {args.input}")

    client = Anthropic()

    rows = []
    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rows.append(json.loads(line))
            if args.limit and len(rows) >= args.limit:
                break

    print(f"Generating explanations for {len(rows):,} rows with {args.model}...", flush=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    failed = 0
    with args.output.open("w", encoding="utf-8") as out:
        for i, row in enumerate(rows, 1):
            try:
                explanation = generate_one(client, args.model, row["prompt"], args.max_tokens)
            except RuntimeError as exc:
                failed += 1
                print(f"  [{i}/{len(rows)}] FAILED id={row['id']}: {exc}", flush=True)
                continue

            out.write(json.dumps({"id": row["id"], "explanation": explanation}, ensure_ascii=False) + "\n")
            out.flush()
            written += 1

            if i % 10 == 0 or i == len(rows):
                print(f"  [{i}/{len(rows)}] written={written} failed={failed}", flush=True)

    print(f"\nDone. Written: {written} | Failed: {failed}")
    print(f"Output: {args.output}")
    print(
        "\nNext: read a sample of the output against baseline_explanation in "
        f"{args.input} to judge quality before scaling up (see teacher_output_schema.json "
        "and merge_teacher_outputs.py for the next pipeline step)."
    )


if __name__ == "__main__":
    main()
