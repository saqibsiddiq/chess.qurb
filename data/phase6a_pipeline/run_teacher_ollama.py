#!/usr/bin/env python3
"""Generate teacher explanations for a Chesy teacher-pilot file via a
local Ollama model — no API key, no cost.

Same input/output contract as run_teacher_claude.py: reads rows with a
pre-built `prompt` field and writes one {"id", "explanation"} JSON object
per line, matching teacher_output_schema.json. Requires the Ollama daemon
running locally (`ollama serve`, usually already running as a service)
and the target model already pulled (`ollama pull <model>`).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests

DEFAULT_MODEL = "qwen2.5:7b-instruct"
DEFAULT_HOST = "http://localhost:11434"
MAX_RETRIES = 3


def generate_one(host: str, model: str, prompt: str, max_tokens: int) -> str:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.post(
                f"{host}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "options": {"num_predict": max_tokens},
                },
                timeout=120,
            )
            response.raise_for_status()
            return response.json()["message"]["content"].strip()
        except (requests.RequestException, KeyError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(2 * attempt)
    raise RuntimeError(f"Failed after {MAX_RETRIES} attempts: {last_error}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path("data/phase6/teacher_pilot_10k.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("data/phase6/teacher_output_trial_ollama.jsonl"))
    ap.add_argument("--limit", type=int, default=100, help="Number of rows to process; 0 means all.")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--max-tokens", type=int, default=250)
    args = ap.parse_args()

    try:
        requests.get(f"{args.host}/api/tags", timeout=5).raise_for_status()
    except requests.RequestException as exc:
        raise SystemExit(
            f"Could not reach Ollama at {args.host} ({exc}). "
            "Is the daemon running? Try `ollama serve` or check `systemctl status ollama`."
        ) from exc

    if not args.input.exists():
        raise SystemExit(f"Input not found: {args.input}")

    rows = []
    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rows.append(json.loads(line))
            if args.limit and len(rows) >= args.limit:
                break

    print(f"Generating explanations for {len(rows):,} rows with {args.model} (local)...", flush=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    failed = 0
    started = time.monotonic()
    with args.output.open("w", encoding="utf-8") as out:
        for i, row in enumerate(rows, 1):
            try:
                explanation = generate_one(args.host, args.model, row["prompt"], args.max_tokens)
            except RuntimeError as exc:
                failed += 1
                print(f"  [{i}/{len(rows)}] FAILED id={row['id']}: {exc}", flush=True)
                continue

            out.write(json.dumps({"id": row["id"], "explanation": explanation}, ensure_ascii=False) + "\n")
            out.flush()
            written += 1

            if i % 5 == 0 or i == len(rows):
                elapsed = time.monotonic() - started
                print(f"  [{i}/{len(rows)}] written={written} failed={failed} ({elapsed:.0f}s elapsed)", flush=True)

    print(f"\nDone. Written: {written} | Failed: {failed}")
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
