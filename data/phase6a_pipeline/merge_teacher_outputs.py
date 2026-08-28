#!/usr/bin/env python3
"""Merge teacher explanations into prepared Phase 6 records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-output", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    answers = {}
    with args.teacher_output.open("r", encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            obj = json.loads(line)
            rid = obj.get("id")
            explanation = obj.get("explanation")
            if not rid or not isinstance(explanation, str) or not explanation.strip():
                raise SystemExit(f"Bad teacher record at line {n}")
            answers[str(rid)] = explanation.strip()

    written = 0
    missing = 0
    with args.source.open("r", encoding="utf-8") as source, args.output.open("w", encoding="utf-8") as out:
        for line in source:
            if not line.strip():
                continue
            record = json.loads(line)
            explanation = answers.get(record["id"])
            if explanation is None:
                missing += 1
                continue
            out.write(json.dumps({
                "id": record["id"],
                "game_id": record["game_id"],
                "input": record["input"],
                "target": explanation,
                "baseline_explanation": record.get("baseline_explanation"),
            }, ensure_ascii=False, separators=(",", ":")) + "\n")
            written += 1

    print(f"Written: {written}")
    print(f"Missing teacher outputs: {missing}")


if __name__ == "__main__":
    main()
