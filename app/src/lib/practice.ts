import { invoke } from '@tauri-apps/api/core';
import { Chess } from 'chess.js';
import type { AnalysisResult } from './analysis';
import { toCpValue } from './reviewEngine';
import { detectNewlyHangingPiece, PIECE_NAMES, uciToSan } from './explanations';

export type PracticeVerdict = 'best' | 'good' | 'inaccurate' | 'poor';

export interface PracticeAttempt {
  uci: string;
  san: string;
  verdict: PracticeVerdict;
  lossCp: number;
  isEngineMove: boolean;
  reason?: string;
}

const GOOD_CEILING_CP = 30;
const INACCURATE_CEILING_CP = 100;

export const VERDICT_COPY: Record<PracticeVerdict, { title: string; tone: string }> = {
  best: { title: 'Best move', tone: 'practice-best' },
  good: { title: 'Strong', tone: 'practice-good' },
  inaccurate: { title: 'Inaccurate', tone: 'practice-inaccurate' },
  poor: { title: 'Too costly', tone: 'practice-poor' },
};

export function applyAttempt(
  fenBefore: string,
  from: string,
  to: string,
): { fenAfter: string; uci: string; san: string; isCheckmate: boolean } | null {
  try {
    const chess = new Chess(fenBefore);
    const needsPromotion = chess
      .moves({ verbose: true })
      .some((m) => m.from === from && m.to === to && m.promotion);
    const move = chess.move(
      needsPromotion ? { from, to, promotion: 'q' } : { from, to },
    );
    return {
      fenAfter: chess.fen(),
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      san: move.san,
      isCheckmate: chess.isCheckmate(),
    };
  } catch {
    return null;
  }
}

async function evaluatePosition(fen: string, depth: number): Promise<AnalysisResult> {
  return invoke<AnalysisResult>('evaluate_position', { fen, depth });
}

function describeAttempt(
  fenBefore: string,
  fenAfter: string,
  uci: string,
  mover: 'w' | 'b',
  after: AnalysisResult,
  lossCp: number,
): string | undefined {
  const mate = after.evalMate;
  if (mate !== null && mate !== undefined) {
    const moverIsWhite = mover === 'w';
    const matesMover = (moverIsWhite && mate < 0) || (!moverIsWhite && mate > 0);
    if (matesMover) return `That allows a forced mate in ${Math.abs(mate)}.`;
  }

  try {
    const before = new Chess(fenBefore);
    const board = new Chess(fenAfter);
    const hanging = detectNewlyHangingPiece(before, board, uci, mover);
    if (hanging) {
      const attacker = hanging.attackerSquare ? board.get(hanging.attackerSquare) : null;
      return attacker
        ? `That leaves your ${hanging.name} on ${hanging.square} hanging to the ${PIECE_NAMES[attacker.type]} on ${hanging.attackerSquare}.`
        : `That leaves your ${hanging.name} on ${hanging.square} undefended.`;
    }
  } catch {
  }

  if (lossCp >= INACCURATE_CEILING_CP) {
    return `It hands over about ${(lossCp / 100).toFixed(2)} pawns without a concrete threat behind it.`;
  }
  return undefined;
}

export async function judgeAttempt(
  fenBefore: string,
  from: string,
  to: string,
  before: AnalysisResult,
  depth: number,
): Promise<PracticeAttempt | null> {
  const applied = applyAttempt(fenBefore, from, to);
  if (!applied) return null;

  const isWhite = fenBefore.split(' ')[1] !== 'b';
  const isEngineMove = applied.uci === before.bestMove;

  if (applied.isCheckmate) {
    return { ...applied, verdict: 'best', lossCp: 0, isEngineMove };
  }

  const after = await evaluatePosition(applied.fenAfter, depth);

  const cpBefore = toCpValue(before.evalCp, before.evalMate, isWhite);
  const cpAfter = toCpValue(after.evalCp, after.evalMate, !isWhite);
  const rawDelta = isWhite ? cpBefore - cpAfter : cpAfter - cpBefore;
  const lossCp = Math.max(0, rawDelta);

  let verdict: PracticeVerdict;
  if (isEngineMove) verdict = 'best';
  else if (lossCp < GOOD_CEILING_CP) verdict = 'good';
  else if (lossCp < INACCURATE_CEILING_CP) verdict = 'inaccurate';
  else verdict = 'poor';

  const reason =
    verdict === 'best' || verdict === 'good'
      ? undefined
      : describeAttempt(fenBefore, applied.fenAfter, applied.uci, isWhite ? 'w' : 'b', after, lossCp);

  return { ...applied, verdict, lossCp, isEngineMove, reason };
}

export function bestMoveSan(fenBefore: string, before: AnalysisResult): string {
  return uciToSan(fenBefore, before.bestMove, 'the engine move');
}
