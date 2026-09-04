import { Chess } from 'chess.js';
import type { GameReview } from './reviewEngine';
import { toCpValue, winPercent } from './reviewEngine';

// One accuracy figure for a whole game hides the useful part. Opening,
// middlegame and endgame accuracy are usually very different numbers for
// the same person, and they point at different things to study.

export type Phase = 'opening' | 'middlegame' | 'endgame';

export const PHASE_LABELS: Record<Phase, string> = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
};

/** Standard values; the king is excluded because it never leaves. */
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/// Total non-king material at the start, both sides combined.
const STARTING_MATERIAL = 78;

/// Below this the game is an endgame. Roughly the point where each side
/// has a rook and a minor piece left.
const ENDGAME_MATERIAL = 26;

function materialOn(fen: string): number {
  try {
    const board = new Chess(fen).board();
    let total = 0;
    for (const row of board) {
      for (const square of row) {
        if (square) total += PIECE_VALUES[square.type] ?? 0;
      }
    }
    return total;
  } catch {
    return STARTING_MATERIAL;
  }
}

/**
 * Labels each ply with the phase it belongs to.
 *
 * Material is the boundary rather than move number, because move number
 * says nothing about the position: a queenless grind can reach an endgame
 * by move 15, while a sharp middlegame can still be raging at move 40.
 * The opening ends where the game left known theory — the one boundary
 * the app can state rather than estimate — falling back to a ply count
 * for games with no book data.
 */
export function phasesFor(review: GameReview, bookExitPly: number | null): Phase[] {
  const openingEnds = bookExitPly ?? Math.min(20, review.moves.length);

  return review.moves.map((move, i) => {
    if (i < openingEnds) return 'opening';
    return materialOn(move.fenAfter) <= ENDGAME_MATERIAL ? 'endgame' : 'middlegame';
  });
}

export interface PhaseAccuracy {
  phase: Phase;
  moves: number;
  accuracy: number;
}

/**
 * Accuracy per phase for one colour.
 *
 * Recomputed from the same win-probability curve `reviewEngine` scores
 * whole-game accuracy with, so a phase figure and the overall figure are
 * on the same scale and can be compared directly.
 */
export function phaseAccuracy(
  review: GameReview,
  phases: Phase[],
  side: 'w' | 'b',
): PhaseAccuracy[] {
  const totals: Record<Phase, { sum: number; count: number }> = {
    opening: { sum: 0, count: 0 },
    middlegame: { sum: 0, count: 0 },
    endgame: { sum: 0, count: 0 },
  };

  review.moves.forEach((move, i) => {
    if (move.color !== side) return;

    const previous = i > 0 ? review.moves[i - 1].evalAfter : null;
    const cpBefore = previous ? toCpValue(previous.cp, previous.mate, side === 'w') : 0;
    const cpAfter = toCpValue(move.evalAfter.cp, move.evalAfter.mate, side !== 'w');

    const wpBefore = side === 'w' ? winPercent(cpBefore) : 100 - winPercent(cpBefore);
    const wpAfter = side === 'w' ? winPercent(cpAfter) : 100 - winPercent(cpAfter);

    // Same curve reviewEngine uses for whole-game accuracy.
    const drop = Math.max(0, wpBefore - wpAfter);
    const accuracy = Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

    const bucket = totals[phases[i]];
    bucket.sum += accuracy;
    bucket.count += 1;
  });

  return (['opening', 'middlegame', 'endgame'] as Phase[])
    // A phase the game never reached would otherwise show as 0%, which
    // reads as playing it terribly rather than not playing it at all.
    .filter((phase) => totals[phase].count > 0)
    .map((phase) => ({
      phase,
      moves: totals[phase].count,
      accuracy: totals[phase].sum / totals[phase].count,
    }));
}
