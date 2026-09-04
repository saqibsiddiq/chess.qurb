import { describe, expect, test } from 'vitest';
import { hasUsableAnalysis, toAnalysisResults, type LichessAnalysisEntry } from './lichessAnalysis';
import { parsePgn } from './parsePgn';

const GAME = parsePgn('1. e4 e5 2. Nf3 Nc6 *');

describe('toAnalysisResults', () => {
  test('produces one entry per position, not per ply', () => {
    const analysis: LichessAnalysisEntry[] = [
      { eval: 20 }, { eval: 15 }, { eval: 30 }, { eval: 25 },
    ];
    expect(toAnalysisResults(analysis, GAME)).toHaveLength(5);
  });

  test('shifts evaluations by one: position k is scored by ply k', () => {
    const analysis: LichessAnalysisEntry[] = [
      { eval: 20 }, { eval: 15 }, { eval: 30 }, { eval: 25 },
    ];
    const results = toAnalysisResults(analysis, GAME);
    expect(results[0].evalCp).toBe(0);
    expect(results[1].evalCp).toBe(20);
    expect(results[2].evalCp).toBe(15);
    expect(results[3].evalCp).toBe(30);
    expect(results[4].evalCp).toBe(25);
  });

  test('takes best move from the entry for the ply played *from* that position', () => {
    const analysis: LichessAnalysisEntry[] = [
      { eval: 20 },
      { eval: 15, best: 'd7d5', judgment: { name: 'Inaccuracy', comment: 'd5 was best.' } },
      { eval: 30 },
      { eval: 25 },
    ];
    const results = toAnalysisResults(analysis, GAME);
    expect(results[1].bestMove).toBe('d7d5');
  });

  test('treats an unfaulted ply as its own best move', () => {
    const analysis: LichessAnalysisEntry[] = [{ eval: 20 }, { eval: 15 }, { eval: 30 }, { eval: 25 }];
    const results = toAnalysisResults(analysis, GAME);
    expect(results[0].bestMove).toBe(GAME.moves[0].uci);
    expect(results[2].bestMove).toBe(GAME.moves[2].uci);
  });

  test('carries forced mates through and clears the centipawn score', () => {
    const analysis: LichessAnalysisEntry[] = [
      { eval: 20 }, { eval: 15 }, { eval: 30 }, { mate: -2 },
    ];
    const results = toAnalysisResults(analysis, GAME);
    expect(results[4].evalMate).toBe(-2);
    expect(results[4].evalCp).toBeNull();
  });

  test('reports no runner-up line, since Lichess sends only one', () => {
    const results = toAnalysisResults([{ eval: 20 }, { eval: 15 }, { eval: 30 }, { eval: 25 }], GAME);
    expect(results.every((r) => r.secondMove === null)).toBe(true);
  });
});

describe('hasUsableAnalysis', () => {
  test('accepts an analysis covering every ply', () => {
    expect(hasUsableAnalysis([{ eval: 1 }, { eval: 2 }, { eval: 3 }, { eval: 4 }], GAME)).toBe(true);
  });

  test('rejects a partial analysis rather than drawing a graph with holes', () => {
    expect(hasUsableAnalysis([{ eval: 1 }, { eval: 2 }], GAME)).toBe(false);
  });

  test('rejects a missing analysis', () => {
    expect(hasUsableAnalysis(undefined, GAME)).toBe(false);
  });
});
