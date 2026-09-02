import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult, Classification } from './analysis';
import type { ParsedMove } from './parsePgn';
import type { MoveExplanation, TacticalMotif } from './explanations';

// The exact structured facts the SLM was trained on (see
// ml/data/preparation/build_sft_dataset.py) — field names/casing must
// match app/src-tauri/src/slm.rs's `MoveFacts` (serde camelCase).
export interface MoveFacts {
  fen: string;
  color: 'white' | 'black';
  moveNumber: number;
  playedMove: string;
  bestMove: string;
  evalBeforeCp: number | null;
  evalBeforeMate: number | null;
  evalAfterCp: number | null;
  evalAfterMate: number | null;
  lossCp: number | null;
  classification: Classification;
  motif: string;
  motifDetail: Record<string, unknown> | null;
}

// The training data's motif vocabulary doesn't include 'positive' or
// 'evaluation' (explainMove()'s labels for "no specific tactic, just a
// good/neutral move") — the closest, actually-trained-on equivalent is
// 'none'. Every other TacticalMotif value matches the training
// vocabulary 1:1 (verified directly against data/phase6/sft_10k_claude.jsonl).
function toTrainedMotif(motif: TacticalMotif): string {
  if (motif === 'positive' || motif === 'evaluation') return 'none';
  return motif;
}

export function buildMoveFacts(
  move: ParsedMove,
  fenBefore: string,
  before: AnalysisResult,
  bestSan: string,
  lossCp: number,
  classification: Classification,
  evalAfterCp: number | null,
  evalAfterMate: number | null,
  explanation: MoveExplanation,
): MoveFacts {
  return {
    fen: fenBefore,
    color: move.color === 'w' ? 'white' : 'black',
    moveNumber: move.moveNumber,
    playedMove: move.san,
    bestMove: bestSan,
    evalBeforeCp: before.evalCp,
    evalBeforeMate: before.evalMate,
    evalAfterCp,
    evalAfterMate,
    lossCp,
    classification,
    motif: toTrainedMotif(explanation.motif),
    motifDetail: explanation.motifDetail ?? null,
  };
}

export interface SlmExplanation {
  text: string;
  elapsedMs: number;
}

// UI-facing state for one move's lazily-generated SLM explanation.
export interface SlmState {
  status: 'loading' | 'done' | 'error' | 'unavailable';
  text?: string;
  elapsedMs?: number;
  warning?: string;
  error?: string;
}

// Note: 'brilliant'/'great' classifications are never seen during
// training (see ml/specs/classification_policy.md — Great/Brilliant
// need MultiPV data the dataset pipeline doesn't compute) — calls for
// those classes are genuinely out-of-distribution, deliberately not
// filtered out here since observing that behavior is itself part of
// deciding whether the SLM output is trustworthy enough to show/replace
// the rule-based text for those cases too.
//
// Strictly on-demand — call this only in direct response to the user
// clicking "explain in depth," never automatically during review or in
// the background. An earlier version fired this for every move as it
// was classified and caused real "app not responding" freezes: the
// SLM's worker thread competing with Stockfish's own search threads for
// CPU during the live review (see project memory, 2026-09-01).
export async function generateSlmExplanation(facts: MoveFacts): Promise<SlmExplanation> {
  return invoke<SlmExplanation>('explain_move', { facts });
}

// Lightweight, client-side sanity check mirroring
// ml/evaluation/evaluate_adapter.py's numeric_problems(): flags a stated
// "N pawns" figure that doesn't match the real loss_cp fact. The Rust
// correction layer (src-tauri/src/correction.rs) should make this
// nearly impossible to trigger — this exists purely to make that
// visible during live testing, not as a redundant safety net.
const PAWNS_RE = /(-?\d+(?:\.\d+)?)\s*pawns?\b/gi;

export function numericMismatch(facts: MoveFacts, text: string): string | null {
  if (facts.lossCp === null || facts.evalAfterMate !== null || facts.evalBeforeMate !== null) return null;
  const expected = Math.round((facts.lossCp / 100) * 100) / 100;
  const matches = [...text.matchAll(PAWNS_RE)];
  for (const m of matches) {
    const stated = Number(m[1]);
    if (Math.abs(stated - expected) > Math.max(0.15, expected * 0.15)) {
      return `stated ${stated} pawns but loss_cp=${facts.lossCp} implies ${expected} pawns`;
    }
  }
  return null;
}
