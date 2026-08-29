import { describe, expect, test } from 'vitest';
import { isBookMove } from './openingBook';

describe('isBookMove', () => {
  const startingFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  test('recognizes a common opening move from the mined book', () => {
    expect(isBookMove(startingFen, 'e2e4')).toBe(true);
  });

  test('rejects a move not present at that position', () => {
    // g1a1 isn't even a legal knight move, but isBookMove only does a
    // lookup — it should just correctly report "not in the book" rather
    // than throwing.
    expect(isBookMove(startingFen, 'g1a1')).toBe(false);
  });

  test('ignores halfmove/fullmove counters when matching the position key', () => {
    const sameFenDifferentCounters = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 12';
    expect(isBookMove(sameFenDifferentCounters, 'e2e4')).toBe(true);
  });

  test('returns false for a position with no book entry at all', () => {
    expect(isBookMove('8/8/8/4k3/8/4K3/8/8 w - - 0 1', 'e3e4')).toBe(false);
  });
});
