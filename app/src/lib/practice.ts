import { invoke } from '@tauri-apps/api/core';
import { Chess } from 'chess.js';
import type { AnalysisResult } from './analysis';
import { toCpValue } from './reviewEngine';
import { detectNewlyHangingPiece, PIECE_NAMES, uciToSan } from './explanations';

/// How well an attempted move did. Ordered best to worst; the copy in
/// `VERDICT_COPY` is keyed off this.
export type PracticeVerdict = 'best' | 'good' | 'inaccurate' | 'poor';

export interface PracticeAttempt {
  uci: string;
  san: string;
  verdict: PracticeVerdict;
  /// Centipawns given up versus the position before the move, measured
  /// exactly as the review measures it.
  lossCp: number;
  /// True when this is the move the engine itself picked.
  isEngineMove: boolean;
  /// One sentence on *why* it went wrong. A verdict and a number tell
  /// someone they were punished without telling them what for, which is
  /// the least useful half of the feedback.
  reason?: string;
}

// Thresholds mirror the spirit of reviewEngine's classifier without
// reusing its full ten-class ladder: practice only needs to answer "did
// that work?", and a four-way answer is easier to act on mid-drill than
// a label like "excellent".
const GOOD_CEILING_CP = 30;
const INACCURATE_CEILING_CP = 100;

// Kept to one or two words on purpose. These sit in a narrow side pane
// beside the move and its cost, and anything longer wraps to a second
// line — measured at 162px available, where "Playable, but there was
// better" wrapped and pushed every row to 48px tall. The vocabulary
// deliberately echoes the review's own classification names so the two
// features read as one product.
export const VERDICT_COPY: Record<PracticeVerdict, { title: string; tone: string }> = {
  best: { title: 'Best move', tone: 'practice-best' },
  good: { title: 'Strong', tone: 'practice-good' },
  inaccurate: { title: 'Inaccurate', tone: 'practice-inaccurate' },
  poor: { title: 'Too costly', tone: 'practice-poor' },
};

/// Applies an attempted move to a position. Returns null when the move
/// isn't legal, which the board shouldn't allow but which a promotion
/// edge case could still produce.
export function applyAttempt(
  fenBefore: string,
  from: string,
  to: string,
): { fenAfter: string; uci: string; san: string; isCheckmate: boolean } | null {
  try {
    const chess = new Chess(fenBefore);
    // Auto-queen: Chessground reports only the two squares, and a
    // promotion picker is a bigger UI change than practice needs. Queen
    // is the right choice in the overwhelming majority of positions.
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

/// Explains what an attempt actually cost, reusing the same detectors the
/// review narrates with rather than inventing a second vocabulary. Checked
/// in order of how decisive each consequence is.
function describeAttempt(
  fenBefore: string,
  fenAfter: string,
  uci: string,
  mover: 'w' | 'b',
  after: AnalysisResult,
  lossCp: number,
): string | undefined {
  // Walking into a forced mate is the whole story; nothing else matters.
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
    // A detector failing shouldn't cost the user their feedback.
  }

  if (lossCp >= INACCURATE_CEILING_CP) {
    return `It hands over about ${(lossCp / 100).toFixed(2)} pawns without a concrete threat behind it.`;
  }
  return undefined;
}

/// Scores an attempt against the position it was played from.
///
/// `before` is the review's own analysis of the position, so the baseline
/// is identical to the one the review scored the real move against —
/// practice never re-derives it and can't drift from it.
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

  // Delivering mate can't be improved on, and asking the engine to
  // evaluate a finished position wastes a search.
  if (applied.isCheckmate) {
    return { ...applied, verdict: 'best', lossCp: 0, isEngineMove };
  }

  const after = await evaluatePosition(applied.fenAfter, depth);

  const cpBefore = toCpValue(before.evalCp, before.evalMate, isWhite);
  // After the move it is the opponent's turn, which is the perspective
  // `toCpValue` needs to read a mate score correctly.
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
