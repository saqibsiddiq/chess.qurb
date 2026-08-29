#!/usr/bin/env python3
"""Generate teacher explanations for a Chesy teacher-pilot file via the
Gemini API's free tier — no credit card needed.

Same input/output contract as run_teacher_claude.py: reads rows with a
pre-built `prompt` field and writes one {"id", "explanation"} JSON object
per line, matching teacher_output_schema.json. Requires GEMINI_API_KEY in
the environment (get one free at https://aistudio.google.com/apikey).
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from google import genai
from google.genai.errors import APIError

DEFAULT_MODEL = "gemini-3.6-flash"
MAX_RETRIES = 3


def generate_one(client: genai.Client, model: str, prompt: str, max_tokens: int) -> str:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config={"max_output_tokens": max_tokens},
            )
            finish_reason = response.candidates[0].finish_reason if response.candidates else None
            text = (response.text or "").strip()
            if finish_reason and str(finish_reason).endswith("MAX_TOKENS"):
                raise RuntimeError(
                    f"Truncated at max_tokens={max_tokens} (thinking tokens ate the budget "
                    f"before the answer finished) — retry with a larger --max-tokens"
                )
            if not text:
                raise RuntimeError(f"Empty response (finish_reason={finish_reason})")
            return text
        except (APIError, RuntimeError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(3 * attempt)
    raise RuntimeError(f"Failed after {MAX_RETRIES} attempts: {last_error}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/phase6/teacher_pilot_10k.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/phase6/teacher_output_trial_gemini.jsonl"))
    ap.add_argument("--limit", type=int, default=100, help="Number of rows to process; 0 means all.")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=1000,
        help=(
            "Total output budget, including this model's internal 'thinking' tokens "
            "(observed 200-450+ per call) — the actual explanation text is usually "
            "well under 150 tokens, but a too-small budget truncates the real answer "
            "before it's written (finish_reason=MAX_TOKENS)."
        ),
    )
    ap.add_argument(
        "--sleep-between",
        type=float,
        default=13.0,
        help="Seconds to sleep between requests. Free tier is 5 requests/minute for this model.",
    )
    args = ap.parse_args()

    if not os.environ.get("GEMINI_API_KEY"):
        raise SystemExit(
            "GEMINI_API_KEY is not set in this environment. Get a free key at "
            "https://aistudio.google.com/apikey, then set it with "
            '`set -Ux GEMINI_API_KEY "..."` in a fish shell, open a new terminal, and try again.'
        )

    if not args.input.exists():
        raise SystemExit(f"Input not found: {args.input}")

    client = genai.Client()

    rows = []
    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rows.append(json.loads(line))
            if args.limit and len(rows) >= args.limit:
                break

    # Resume support: a row already present in an existing --output file
    # (matched by id) is skipped, so an interrupted multi-hour run can
    # just be re-launched with the same --output path instead of starting
    # over or duplicating completed rows.
    already_done: set[str] = set()
    if args.output.exists():
        with args.output.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                already_done.add(json.loads(line)["id"])
        if already_done:
            print(f"Resuming: {len(already_done):,} rows already in {args.output}, skipping those.", flush=True)

    remaining = [row for row in rows if row["id"] not in already_done]

    print(
        f"Generating explanations for {len(remaining):,} rows with {args.model} "
        f"({len(rows) - len(remaining):,} already done)...",
        flush=True,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    failed = 0
    started = time.monotonic()
    with args.output.open("a", encoding="utf-8") as out:
        for i, row in enumerate(remaining, 1):
            try:
                explanation = generate_one(client, args.model, row["prompt"], args.max_tokens)
            except RuntimeError as exc:
                failed += 1
                print(f"  [{i}/{len(remaining)}] FAILED id={row['id']}: {exc}", flush=True)
                continue

            out.write(json.dumps({"id": row["id"], "explanation": explanation}, ensure_ascii=False) + "\n")
            out.flush()
            written += 1

            if i % 10 == 0 or i == len(remaining):
                elapsed = time.monotonic() - started
                print(
                    f"  [{i}/{len(remaining)}] written={written} failed={failed} ({elapsed:.0f}s elapsed)",
                    flush=True,
                )

            if i < len(remaining):
                time.sleep(args.sleep_between)

    print(f"\nDone this run. Written: {written} | Failed: {failed}")
    print(f"Total in output (including prior runs): {len(already_done) + written}")
    print(f"Output: {args.output}")
    if failed:
        print(f"Re-run the same command to retry the {failed} failed row(s) plus any not yet attempted.")


if __name__ == "__main__":
    main()
