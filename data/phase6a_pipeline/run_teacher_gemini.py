#!/usr/bin/env python3
"""Generate teacher explanations for a Chesy teacher-pilot file via the
Gemini API's free tier — no credit card needed.

Rows are sent in batches (multiple positions packed into one prompt, one
structured-JSON response per batch) rather than one API request per row.
Google's free tier caps *requests* per day per project per model (observed:
500/day), not tokens — so packing N rows into each request multiplies the
number of rows a day's quota can produce by N, with no change to the model
or its grounding instructions. Any row a batch fails to return cleanly
(missing id, malformed JSON, truncation, a whole-batch API error) falls
back to an individual single-row call, so nothing is silently dropped.

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
from typing import Iterator

from google import genai
from google.genai import types
from google.genai.errors import APIError

DEFAULT_MODEL = "gemini-3.6-flash"
MAX_RETRIES = 3

# Batch size default reasons about the free-tier's observed 500
# requests/day/project/model cap: a backlog of several thousand rows needs
# a batch size in the high teens or more just to clear in one day's quota,
# while staying well under typical max-output-token ceilings (~8k) even
# with per-item JSON overhead and the model's internal 'thinking' tokens.
# 20 rows/request leaves comfortable headroom on both ends.
DEFAULT_BATCH_SIZE = 20

# Fallback single-row calls reuse the original tuned budget, independent of
# whatever --max-tokens was computed for the batch size.
SINGLE_MAX_TOKENS = 1000

BATCH_RESPONSE_JSON_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "explanation": {"type": "string"},
        },
        "required": ["id", "explanation"],
        "additionalProperties": False,
    },
}


def chunked(seq: list, size: int) -> Iterator[list]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def build_batch_prompt(rows: list[dict]) -> str:
    header = (
        "You are a chess coach explaining moves to a human player. Below are "
        f"{len(rows)} separate positions, each in its own ITEM block with a "
        "unique id. Treat each ITEM completely independently: use ONLY the "
        "facts given inside that ITEM's own block, never facts from another "
        "ITEM. For each one, explain the key chess idea, why the move was "
        "good or bad, and what the best move improves when one is supplied. "
        "Be concise and instructional. Do not invent tactical claims or "
        "variations.\n\n"
        "Respond with a JSON array containing exactly one object per ITEM, "
        'in the same order, each with "id" copied exactly from the ITEM '
        'header and "explanation" as your text.\n'
    )
    blocks = [f"\n=== ITEM id={row['id']} ===\n{row['prompt']}\n" for row in rows]
    return header + "".join(blocks)


def reconcile_batch(rows: list[dict], parsed: object) -> tuple[dict[str, str], list[dict]]:
    """Match a batch response's items back to their rows by id.

    Returns (id -> explanation for everything that matched cleanly, rows
    that need an individual fallback call because their id came back
    missing, duplicated, or with an empty/invalid explanation).
    """
    expected_ids = {row["id"] for row in rows}
    matched: dict[str, str] = {}
    if isinstance(parsed, list):
        for item in parsed:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            explanation = item.get("explanation")
            if (
                isinstance(item_id, str)
                and item_id in expected_ids
                and item_id not in matched
                and isinstance(explanation, str)
                and explanation.strip()
            ):
                matched[item_id] = explanation.strip()
    missing = [row for row in rows if row["id"] not in matched]
    return matched, missing


def generate_batch(client: genai.Client, model: str, rows: list[dict], max_tokens: int) -> list:
    prompt = build_batch_prompt(rows)
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=max_tokens,
                    response_mime_type="application/json",
                    response_json_schema=BATCH_RESPONSE_JSON_SCHEMA,
                ),
            )
            finish_reason = response.candidates[0].finish_reason if response.candidates else None
            text = (response.text or "").strip()
            if finish_reason and str(finish_reason).endswith("MAX_TOKENS"):
                raise RuntimeError(
                    f"Batch truncated at max_tokens={max_tokens} (thinking tokens ate the "
                    f"budget before all {len(rows)} answers finished) — retry with a larger "
                    "--max-tokens or a smaller --batch-size"
                )
            if not text:
                raise RuntimeError(f"Empty response (finish_reason={finish_reason})")
            parsed = json.loads(text)
            if not isinstance(parsed, list):
                raise RuntimeError(f"Expected a JSON array, got {type(parsed).__name__}")
            return parsed
        except (APIError, RuntimeError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(3 * attempt)
    raise RuntimeError(f"Batch failed after {MAX_RETRIES} attempts: {last_error}")


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
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=(
            "Rows packed into a single API request via structured JSON output. "
            "The free tier caps requests/day, not tokens, so a bigger batch means "
            "more rows per day's quota — but too large risks hitting the "
            "max-output-token ceiling (falls back to per-row calls for that batch "
            "if it does, so it's safe, just slower)."
        ),
    )
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=None,
        help=(
            "Output budget for a batch request, including this model's internal "
            "'thinking' tokens. Defaults to a value scaled from --batch-size "
            "(roughly 260 tokens/row + 600 overhead) if not set."
        ),
    )
    ap.add_argument(
        "--sleep-between",
        type=float,
        default=13.0,
        help="Seconds to sleep between requests (batches, and individual fallback calls), to stay under the free tier's requests/minute limit.",
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

    if args.batch_size < 1:
        raise SystemExit("--batch-size must be at least 1")

    max_tokens = args.max_tokens if args.max_tokens is not None else max(1500, 260 * args.batch_size + 600)

    # A request that hangs indefinitely (no exception, no response) can
    # stall an unattended multi-hour run forever — a real incident, not a
    # hypothetical. An explicit timeout guarantees generate_one()'s retry
    # loop actually gets a chance to run instead of blocking forever.
    client = genai.Client(http_options=genai.types.HttpOptions(timeout=60000))

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
    batches = list(chunked(remaining, args.batch_size))

    print(
        f"Generating explanations for {len(remaining):,} rows with {args.model} "
        f"({len(rows) - len(remaining):,} already done) as {len(batches):,} batches "
        f"of up to {args.batch_size} rows each (max_tokens={max_tokens})...",
        flush=True,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    failed = 0
    fallback_rows: list[dict] = []
    started = time.monotonic()

    with args.output.open("a", encoding="utf-8") as out:
        for batch_num, batch in enumerate(batches, 1):
            try:
                parsed = generate_batch(client, args.model, batch, max_tokens)
                matched, missing = reconcile_batch(batch, parsed)
            except RuntimeError as exc:
                print(
                    f"  [batch {batch_num}/{len(batches)}] FAILED whole batch "
                    f"({len(batch)} rows queued for individual fallback): {exc}",
                    flush=True,
                )
                matched, missing = {}, batch

            for row in batch:
                if row["id"] in matched:
                    out.write(json.dumps({"id": row["id"], "explanation": matched[row["id"]]}, ensure_ascii=False) + "\n")
                    written += 1
            out.flush()

            if missing:
                fallback_rows.extend(missing)
                if matched:
                    print(
                        f"  [batch {batch_num}/{len(batches)}] {len(matched)}/{len(batch)} matched, "
                        f"{len(missing)} queued for individual fallback",
                        flush=True,
                    )
            else:
                elapsed = time.monotonic() - started
                print(
                    f"  [batch {batch_num}/{len(batches)}] {len(matched)}/{len(batch)} matched "
                    f"({elapsed:.0f}s elapsed)",
                    flush=True,
                )

            if batch_num < len(batches):
                time.sleep(args.sleep_between)

        if fallback_rows:
            print(f"\nRetrying {len(fallback_rows):,} row(s) individually...", flush=True)
            for i, row in enumerate(fallback_rows, 1):
                try:
                    explanation = generate_one(client, args.model, row["prompt"], SINGLE_MAX_TOKENS)
                except RuntimeError as exc:
                    failed += 1
                    print(f"  [fallback {i}/{len(fallback_rows)}] FAILED id={row['id']}: {exc}", flush=True)
                else:
                    out.write(json.dumps({"id": row["id"], "explanation": explanation}, ensure_ascii=False) + "\n")
                    out.flush()
                    written += 1

                if i < len(fallback_rows):
                    time.sleep(args.sleep_between)

    print(f"\nDone this run. Written: {written} | Failed: {failed}")
    print(f"Total in output (including prior runs): {len(already_done) + written}")
    print(f"Output: {args.output}")
    if failed:
        print(f"Re-run the same command to retry the {failed} failed row(s) plus any not yet attempted.")


if __name__ == "__main__":
    main()
