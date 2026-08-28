# Phase 6A: Chess Explanation Dataset Pipeline

Prepares extractor JSONL for teacher generation and later SLM fine-tuning.

Pipeline:
extractor JSONL(s) -> prepare_corpus.py -> train/validation/test + benchmark + teacher_queue
-> teacher model -> merged SFT corpus -> tokenizer/model training.

Important:
- Splits are by game_id, never by position.
- inaccuracy/mistake/blunder and non-none motifs are always retained.
- best/excellent/good rows are sampled.
- extractor template explanations are retained as a baseline, not the final SFT target.
- teacher_queue contains structured facts and prompts, not teacher answers.

Usage:
python prepare_corpus.py \
  --input workers/worker_001/data.jsonl \
  --input workers/worker_002/data.jsonl \
  --input workers/worker_003/data.jsonl \
  --input workers/worker_004/data.jsonl \
  --output phase6 \
  --seed 42
