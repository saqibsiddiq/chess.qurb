import { toCpValue, winPercent, type GameReview, type ReviewedMove } from './reviewEngine';

// An eighty-move review presents eighty moves as equally worth reading.
// They aren't: most games turn on two or three moments. Ranking those
// surfaces the part that actually decided the result, and teaches the
// more useful skill — noticing when a position is critical.

export interface CriticalMoment {
  index: number;
  move: ReviewedMove;
  /// Win probability, in percentage points, that the mover gave away.
  swing: number;
  /// The move handed the advantage over rather than merely denting it —
  /// the mover went from level-or-better to worse-than-level.
  turningPoint: boolean;
}

/// Below this a move is a wobble, not a moment. Ten points of win
/// probability is roughly the boundary the classifier already treats as
/// the step from "good" to "inaccuracy".
const MIN_SWING = 10;

/// Win probability from the moving side's point of view.
function moverWinPercent(
  evalCp: number | null,
  evalMate: number | null,
  mover: 'w' | 'b',
): number {
  const cp = toCpValue(evalCp, evalMate, mover === 'w');
  const whiteWp = winPercent(cp);
  return mover === 'w' ? whiteWp : 100 - whiteWp;
}

/**
 * Ranks the moves that decided the game, biggest swing first.
 *
 * Swing is measured in win probability rather than centipawns on purpose.
 * Centipawns treat every loss the same, so throwing away three pawns from
 * an already-hopeless position would outrank throwing away a level game —
 * exactly backwards for "what decided this". Win probability saturates at
 * both ends, so only moves that changed the likely result score highly.
 */
export function findCriticalMoments(review: GameReview, limit = 3): CriticalMoment[] {
  const moments: CriticalMoment[] = [];

  review.moves.forEach((move, index) => {
    // The position this move was played from is the previous move's
    // result. The opening position is taken as level, which is true
    // enough that the first move is never a turning point anyway.
    const previous = index > 0 ? review.moves[index - 1].evalAfter : null;
    const wpBefore = previous
      ? moverWinPercent(previous.cp, previous.mate, move.color)
      : 50;
    const wpAfter = moverWinPercent(move.evalAfter.cp, move.evalAfter.mate, move.color);

    const swing = wpBefore - wpAfter;
    if (swing < MIN_SWING) return;

    moments.push({
      index,
      move,
      swing,
      turningPoint: wpBefore >= 50 && wpAfter < 50,
    });
  });

  return moments.sort((a, b) => b.swing - a.swing).slice(0, limit);
}

/// Phrases a moment for display. Kept here rather than in the component so
/// the wording travels with the ranking that produced it.
export function describeMoment(moment: CriticalMoment): string {
  const side = moment.move.color === 'w' ? 'White' : 'Black';
  if (moment.turningPoint) return `${side} handed over the advantage`;
  if (moment.swing >= 30) return `${side} let a large edge slip`;
  return `${side} gave ground here`;
}
