#!/usr/bin/env python3
"""Offline tests for the batching logic in run_teacher_gemini.py.

No GEMINI_API_KEY and no network access required: generate_batch() is
exercised against a mocked client so this validates the prompt-building,
response-reconciliation, and retry logic without spending any free-tier
quota. Run with: python3 -m unittest data/phase6a_pipeline/test_run_teacher_gemini_batch.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

import run_teacher_gemini as rtg  # noqa: E402

ROWS = [
    {"id": "g1:1:white:e2e4", "prompt": "FEN: ...\nPlayed move: e4"},
    {"id": "g1:1:black:e7e5", "prompt": "FEN: ...\nPlayed move: e5"},
    {"id": "g2:5:white:g1f3", "prompt": "FEN: ...\nPlayed move: Nf3"},
]


def make_response(text: str, finish_reason: str = "STOP") -> MagicMock:
    candidate = MagicMock()
    candidate.finish_reason = finish_reason
    response = MagicMock()
    response.candidates = [candidate]
    response.text = text
    return response


class BuildBatchPromptTests(unittest.TestCase):
    def test_includes_every_id_and_prompt_in_order(self) -> None:
        prompt = rtg.build_batch_prompt(ROWS)
        positions = [prompt.index(f"id={row['id']}") for row in ROWS]
        self.assertEqual(positions, sorted(positions), "items must appear in input order")
        for row in ROWS:
            self.assertIn(row["id"], prompt)
            self.assertIn(row["prompt"], prompt)


class ReconcileBatchTests(unittest.TestCase):
    def test_all_matched_cleanly(self) -> None:
        parsed = [{"id": r["id"], "explanation": f"exp {r['id']}"} for r in ROWS]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(set(matched), {r["id"] for r in ROWS})
        self.assertEqual(missing, [])

    def test_scrambled_order_still_matches_by_id(self) -> None:
        parsed = [{"id": r["id"], "explanation": f"exp {r['id']}"} for r in reversed(ROWS)]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(set(matched), {r["id"] for r in ROWS})
        self.assertEqual(missing, [])

    def test_missing_id_falls_back(self) -> None:
        parsed = [{"id": r["id"], "explanation": f"exp {r['id']}"} for r in ROWS[:2]]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(set(matched), {ROWS[0]["id"], ROWS[1]["id"]})
        self.assertEqual([r["id"] for r in missing], [ROWS[2]["id"]])

    def test_empty_explanation_falls_back(self) -> None:
        parsed = [{"id": r["id"], "explanation": ""} for r in ROWS]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(matched, {})
        self.assertEqual(len(missing), len(ROWS))

    def test_non_string_explanation_falls_back(self) -> None:
        parsed = [{"id": ROWS[0]["id"], "explanation": None}]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(matched, {})
        self.assertEqual(len(missing), len(ROWS))

    def test_unknown_id_ignored(self) -> None:
        parsed = [{"id": "not-a-real-id", "explanation": "hallucinated row"}]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(matched, {})
        self.assertEqual(len(missing), len(ROWS))

    def test_duplicate_id_keeps_first_only(self) -> None:
        parsed = [
            {"id": ROWS[0]["id"], "explanation": "first"},
            {"id": ROWS[0]["id"], "explanation": "second"},
        ]
        matched, missing = rtg.reconcile_batch(ROWS, parsed)
        self.assertEqual(matched, {ROWS[0]["id"]: "first"})
        self.assertEqual(len(missing), len(ROWS) - 1)

    def test_non_list_parsed_returns_all_missing(self) -> None:
        matched, missing = rtg.reconcile_batch(ROWS, {"not": "a list"})
        self.assertEqual(matched, {})
        self.assertEqual(len(missing), len(ROWS))


class GenerateBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sleep_patcher = patch("run_teacher_gemini.time.sleep")
        self.sleep_patcher.start()
        self.addCleanup(self.sleep_patcher.stop)

    def test_success_on_first_attempt(self) -> None:
        expected = [{"id": r["id"], "explanation": "ok"} for r in ROWS]
        client = MagicMock()
        client.models.generate_content.return_value = make_response(json.dumps(expected))

        result = rtg.generate_batch(client, "gemini-3.5-flash-lite", ROWS, max_tokens=2000)

        self.assertEqual(result, expected)
        self.assertEqual(client.models.generate_content.call_count, 1)

    def test_retries_then_succeeds_on_malformed_json(self) -> None:
        client = MagicMock()
        client.models.generate_content.side_effect = [
            make_response("not json"),
            make_response(json.dumps([{"id": ROWS[0]["id"], "explanation": "ok"}])),
        ]

        result = rtg.generate_batch(client, "gemini-3.5-flash-lite", ROWS, max_tokens=2000)

        self.assertEqual(result, [{"id": ROWS[0]["id"], "explanation": "ok"}])
        self.assertEqual(client.models.generate_content.call_count, 2)

    def test_raises_after_max_retries_on_persistent_malformed_json(self) -> None:
        client = MagicMock()
        client.models.generate_content.return_value = make_response("still not json")

        with self.assertRaises(RuntimeError):
            rtg.generate_batch(client, "gemini-3.5-flash-lite", ROWS, max_tokens=2000)

        self.assertEqual(client.models.generate_content.call_count, rtg.MAX_RETRIES)

    def test_truncation_raises_after_retries(self) -> None:
        client = MagicMock()
        client.models.generate_content.return_value = make_response(
            json.dumps([{"id": ROWS[0]["id"], "explanation": "cut off"}]), finish_reason="MAX_TOKENS"
        )

        with self.assertRaises(RuntimeError):
            rtg.generate_batch(client, "gemini-3.5-flash-lite", ROWS, max_tokens=50)

        self.assertEqual(client.models.generate_content.call_count, rtg.MAX_RETRIES)

    def test_non_array_json_raises_after_retries(self) -> None:
        client = MagicMock()
        client.models.generate_content.return_value = make_response(json.dumps({"id": "x", "explanation": "y"}))

        with self.assertRaises(RuntimeError):
            rtg.generate_batch(client, "gemini-3.5-flash-lite", ROWS, max_tokens=2000)

        self.assertEqual(client.models.generate_content.call_count, rtg.MAX_RETRIES)


if __name__ == "__main__":
    unittest.main()
