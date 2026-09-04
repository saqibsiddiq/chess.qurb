import { describe, expect, test } from 'vitest';
import { phaseAccuracy, phasesFor } from './phases';
import type { GameReview, ReviewedMove } from './reviewEngine';

/** Positions with progressively less material, for phase boundaries. */
const FULL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MIDDLE = 'r3k2r/pp3ppp/8/8/8/8/PP3PPP/R3K2R w KQkq - 0 1'; // 2R + 6P a side = 32
const BARE = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'; // one pawn

function move(color: 'w' | 'b', fenAfter: string, cp: number): ReviewedMove {
  return {
    moveNumber: 1,
    color,
    san: 'e4',
    uci: 'e2e4',
    fenAfter,
    classification: 'good',
    lossCp: 0,
    evalAfter: { cp, mate: null },
    bestMoveUci: '',
    explanation: { title: '', summary: '', detail: '', motif: 'none', shapes: [] },
  } as unknown as ReviewedMove;
}

function review(moves: ReviewedMove[]): GameReview {
  return { moves, whiteAccuracy: 0, blackAccuracy: 0 };
}

describe('phasesFor', () => {
  test('the opening ends where the game left book', () => {
    const r = review([
      move('w', FULL, 0), move('b', FULL, 0),
      move('w', FULL, 0), move('b', FULL, 0),
    ]);
    expect(phasesFor(r, 2)).toEqual(['opening', 'opening', 'middlegame', 'middlegame']);
  });

  test('falls back to a ply count when book data is missing', () => {
    const r = review(Array.from({ length: 4 }, (_, i) => move(i % 2 ? 'b' : 'w', FULL, 0)));
    // Short game, no book exit: everything is still opening.
    expect(phasesFor(r, null).every((p) => p === 'opening')).toBe(true);
  });

  test('uses material, not move number, to find the endgame', () => {
    // Position 2 still has rooks and pawns; position 3 is down to a pawn.
    const r = review([
      move('w', FULL, 0),
      move('b', MIDDLE, 0),
      move('w', BARE, 0),
    ]);
    const phases = phasesFor(r, 1);
    expect(phases[1]).toBe('middlegame');
    // A queenless grind can reach an endgame early, which a move-number
    // boundary would miss entirely.
    expect(phases[2]).toBe('endgame');
  });
});

describe('phaseAccuracy', () => {
  test('scores only the requested colour', () => {
    const r = review([
      move('w', FULL, 0),
      move('b', FULL, -600), // Black's own doing
      move('w', FULL, 0),
    ]);
    const white = phaseAccuracy(r, phasesFor(r, 0), 'w');
    // White never lost ground, so White's figure must be unaffected by
    // Black's collapse.
    expect(white[0].accuracy).toBeGreaterThan(95);
  });

  test('separates the phases it reports', () => {
    const r = review([
      move('w', FULL, 0), move('b', FULL, 0),
      move('w', BARE, 0), move('b', BARE, 0),
    ]);
    const phases = phasesFor(r, 2);
    const result = phaseAccuracy(r, phases, 'w');
    expect(result.map((p) => p.phase)).toEqual(['opening', 'endgame']);
    expect(result.every((p) => p.moves === 1)).toBe(true);
  });

  test('omits phases the game never reached', () => {
    // Reporting 0% for a phase that was never played reads as playing it
    // terribly rather than not playing it at all.
    const r = review([move('w', FULL, 0), move('b', FULL, 0)]);
    const result = phaseAccuracy(r, phasesFor(r, 10), 'w');
    expect(result.map((p) => p.phase)).toEqual(['opening']);
  });

  test('a bad move lowers the phase it happened in', () => {
    const r = review([
      move('w', FULL, 0),
      move('b', FULL, 0),
      move('w', BARE, -900), // White throws it away in the endgame
      move('b', BARE, -900),
    ]);
    const result = phaseAccuracy(r, phasesFor(r, 2), 'w');
    const opening = result.find((p) => p.phase === 'opening')!;
    const endgame = result.find((p) => p.phase === 'endgame')!;
    expect(endgame.accuracy).toBeLessThan(opening.accuracy);
  });
});
