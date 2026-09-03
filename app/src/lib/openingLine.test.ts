import { describe, expect, test } from 'vitest';
import { bookContinuations, openingLine } from './openings';
import { parsePgn } from './parsePgn';

describe('bookContinuations', () => {
  test('lists what the corpus plays from a position', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves = bookContinuations(start);
    expect(moves).toContain('e2e4');
    expect(moves).toContain('d2d4');
  });

  test('returns nothing for a position the corpus never reached', () => {
    expect(bookContinuations('8/8/8/4k3/8/4K3/8/8 w - - 0 1')).toEqual([]);
  });
});

describe('openingLine', () => {
  test('walks the theory and names the alternatives at each step', () => {
    const line = openingLine(parsePgn('1. e4 e5 2. Nf3 Nc6 *'));
    expect(line[0]).toMatchObject({ ply: 0, san: 'e4', inBook: true });
    // Real alternatives from the mined book, not the move itself.
    expect(line[0].alternatives.length).toBeGreaterThan(0);
    expect(line[0].alternatives).not.toContain('e4');
  });

  test('stops at the move that left book', () => {
    // Na3 is the one first move the corpus does not play.
    const line = openingLine(parsePgn('1. Na3 e5 2. Nc4 d5 *'));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ san: 'Na3', inBook: false });
  });

  test('caps the walk so a long game does not bury the opening', () => {
    const long = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 *');
    expect(openingLine(long, 4).length).toBeLessThanOrEqual(4);
  });
});
