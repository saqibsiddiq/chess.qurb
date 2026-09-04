import { toCpValue, winPercent, type GameReview, type ReviewedMove } from './reviewEngine';

export interface CriticalMoment {
  index: number;
  move: ReviewedMove;
  swing: number;
  turningPoint: boolean;
}

const MIN_SWING = 10;

function moverWinPercent(
  evalCp: number | null,
  evalMate: number | null,
  mover: 'w' | 'b',
): number {
  const cp = toCpValue(evalCp, evalMate, mover === 'w');
  const whiteWp = winPercent(cp);
  return mover === 'w' ? whiteWp : 100 - whiteWp;
}

export function findCriticalMoments(review: GameReview, limit = 3): CriticalMoment[] {
  const moments: CriticalMoment[] = [];

  review.moves.forEach((move, index) => {
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

export function describeMoment(moment: CriticalMoment): string {
  const side = moment.move.color === 'w' ? 'White' : 'Black';
  if (moment.turningPoint) return `${side} handed over the advantage`;
  if (moment.swing >= 30) return `${side} let a large edge slip`;
  return `${side} gave ground here`;
}
