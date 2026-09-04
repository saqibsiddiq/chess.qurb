import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult, Classification } from './analysis';
import type { ParsedMove } from './parsePgn';
import type { MoveExplanation, TacticalMotif } from './explanations';

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

export interface SlmState {
  status: 'loading' | 'done' | 'error' | 'unavailable';
  text?: string;
  elapsedMs?: number;
  warning?: string;
  error?: string;
}

export async function generateSlmExplanation(facts: MoveFacts): Promise<SlmExplanation> {
  return invoke<SlmExplanation>('explain_move', { facts });
}

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
