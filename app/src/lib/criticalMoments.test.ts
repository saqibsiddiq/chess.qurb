import { describe, expect, test } from 'vitest';
import { describeMoment, findCriticalMoments } from './criticalMoments';
import type { GameReview, ReviewedMove } from './reviewEngine';

function move(
  color: 'w' | 'b',
  cp: number | null,
  over: Partial<ReviewedMove> = {},
): ReviewedMove {
  return {
    moveNumber: 1,
    color,
    san: 'e4',
    uci: 'e2e4',
    fenAfter: '',
    classification: 'good',
    lossCp: 0,
    evalAfter: { cp, mate: null },
    bestMoveUci: '',
    explanation: { title: '', summary: '', detail: '', motif: 'none', shapes: [] },
    ...over,
  } as unknown as ReviewedMove;
}

function review(moves: ReviewedMove[]): GameReview {
  return { moves, whiteAccuracy: 0, blackAccuracy: 0 };
}

describe('findCriticalMoments', () => {
  test('ignores moves that barely move the needle', () => {
    // A few tenths of a pawn either way is ordinary play.
    const r = review([move('w', 20), move('b', 10), move('w', 30)]);
    expect(findCriticalMoments(r)).toEqual([]);
  });

  test('ranks by win probability, not centipawns', () => {
    // Move 0: White throws a level game (0 -> -400), a huge win-% swing.
    // Move 2: White drops another 600cp, but from an already-lost
    // position, so it barely changes the likely result.
    const r = review([
      move('w', -400, { san: 'Qxh7' }),
      move('b', -400, { san: 'Kxh7' }),
      move('w', -1000, { san: 'Rb1' }),
    ]);
    const found = findCriticalMoments(r);
    expect(found[0].move.san).toBe('Qxh7');
    // The second slip is worth less despite giving up more material.
    const first = found.find((m) => m.move.san === 'Qxh7')!;
    const later = found.find((m) => m.move.san === 'Rb1');
    if (later) expect(later.swing).toBeLessThan(first.swing);
  });

  test('flags handing over the advantage as a turning point', () => {
    // White is level, then ends up clearly worse: the game changed hands.
    const r = review([move('w', -500, { san: 'Nd5' })]);
    const [moment] = findCriticalMoments(r);
    expect(moment.turningPoint).toBe(true);
    expect(describeMoment(moment)).toBe('White handed over the advantage');
  });

  test('a slip inside a still-winning position is not a turning point', () => {
    // White goes from overwhelming to merely winning — costly, but the
    // advantage never changed hands.
    const r = review([move('w', 900), move('b', 900), move('w', 300, { san: 'Rc1' })]);
    const found = findCriticalMoments(r);
    const slip = found.find((m) => m.move.san === 'Rc1');
    if (slip) expect(slip.turningPoint).toBe(false);
  });

  test('reads the swing from the moving side, not from White', () => {
    // Black to move at +400 for White (bad for Black) and ends at +900:
    // Black lost ground, so this must register as Black's mistake.
    const r = review([move('w', 400), move('b', 900, { san: 'Qa5' })]);
    const found = findCriticalMoments(r);
    expect(found[0].move.san).toBe('Qa5');
    expect(found[0].move.color).toBe('b');
    expect(describeMoment(found[0])).toContain('Black');
  });

  test('returns at most the requested number, biggest first', () => {
    const r = review([
      move('w', -300),
      move('b', 200),
      move('w', -600),
      move('b', 400),
      move('w', -900),
    ]);
    const found = findCriticalMoments(r, 2);
    expect(found).toHaveLength(2);
    expect(found[0].swing).toBeGreaterThanOrEqual(found[1].swing);
  });

  test('handles an empty review', () => {
    expect(findCriticalMoments(review([]))).toEqual([]);
  });
});
