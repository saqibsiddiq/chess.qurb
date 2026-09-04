import { describe, expect, test } from 'vitest';
import { buildSummary, reviewId } from './storage';
import type { GameReview, ReviewedMove } from './reviewEngine';
import type { ParsedGame } from './parsePgn';

function mkMove(
  color: 'w' | 'b',
  classification: string,
  motif: string,
): ReviewedMove {
  return {
    moveNumber: 1,
    color,
    san: 'e4',
    uci: 'e2e4',
    fenAfter: '',
    classification,
    lossCp: 0,
    evalAfter: { cp: 0, mate: null },
    bestMoveUci: 'e2e4',
    explanation: { title: '', summary: '', detail: '', motif, shapes: [] },
    slmFacts: {},
  } as unknown as ReviewedMove;
}

const game = {
  headers: { White: 'alice', Black: 'bob', Result: '1-0', Date: '2026.09.01' },
  moves: [],
  startingFen: '',
} as unknown as ParsedGame;

describe('reviewId', () => {
  test('is stable for the same PGN', () => {
    const pgn = '[White "a"]\n1. e4 e5 *';
    expect(reviewId(pgn)).toBe(reviewId(pgn));
  });

  test('differs for PGNs sharing a long prefix', () => {
    const base = '[Event "x"]\n[White "alice"]\n[Black "bob"]\n1. e4 e5 2. Nf3 Nc6 3. Bb5 ';
    expect(reviewId(`${base}a6 4. Ba4 *`)).not.toBe(reviewId(`${base}Nf6 4. O-O *`));
  });

  test('produces only filesystem-safe characters', () => {
    for (const pgn of ['', '1. e4 *', '[White "a/b"]\n1. d4 ..'.repeat(20)]) {
      expect(reviewId(pgn)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
});

describe('buildSummary', () => {
  test('tallies classifications and motifs per colour', () => {
    const review: GameReview = {
      moves: [
        mkMove('w', 'blunder', 'hanging_piece'),
        mkMove('w', 'best', 'positive'),
        mkMove('b', 'blunder', 'fork'),
        mkMove('b', 'blunder', 'hanging_piece'),
        mkMove('w', 'good', 'evaluation'),
      ],
      whiteAccuracy: 71.5,
      blackAccuracy: 44.25,
    };

    const summary = buildSummary('abc123', game, review);

    expect(summary.whiteCounts).toEqual({ blunder: 1, best: 1, good: 1 });
    expect(summary.blackCounts).toEqual({ blunder: 2 });
    expect(summary.whiteMotifs).toEqual({ hanging_piece: 1 });
    expect(summary.blackMotifs).toEqual({ fork: 1, hanging_piece: 1 });
  });

  test('carries the metadata a games list needs', () => {
    const review: GameReview = { moves: [mkMove('w', 'best', 'positive')], whiteAccuracy: 90, blackAccuracy: 80 };
    const summary = buildSummary('abc123', game, review);

    expect(summary).toMatchObject({
      id: 'abc123',
      white: 'alice',
      black: 'bob',
      result: '1-0',
      date: '2026.09.01',
      moveCount: 1,
      whiteAccuracy: 90,
      blackAccuracy: 80,
    });
    expect(summary.savedAt).toBeGreaterThan(0);
  });

  test('falls back gracefully when PGN headers are missing', () => {
    const bare = { headers: {}, moves: [], startingFen: '' } as unknown as ParsedGame;
    const review: GameReview = { moves: [], whiteAccuracy: 100, blackAccuracy: 100 };
    const summary = buildSummary('x', bare, review);
    expect(summary.white).toBe('Unknown');
    expect(summary.black).toBe('Unknown');
    expect(summary.result).toBe('*');
  });
});
