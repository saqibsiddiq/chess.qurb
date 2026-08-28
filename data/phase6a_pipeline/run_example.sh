#!/usr/bin/env bash
set -euo pipefail

python prepare_corpus.py \
  --input workers/worker_001/data.jsonl \
  --input workers/worker_002/data.jsonl \
  --input workers/worker_003/data.jsonl \
  --input workers/worker_004/data.jsonl \
  --output phase6 \
  --seed 42 \
  --normal-keep-probability 0.20
