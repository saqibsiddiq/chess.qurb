import { describe, expect, test } from 'vitest';
import { Chess } from 'chess.js';
import { detectMissedTactic, detectNewlyHangingPiece, explainMove } from './explanations';
import type { AnalysisResult } from './analysis';
import type { ParsedMove } from './parsePgn';

function mkAnalysis(a: Partial<AnalysisResult>): AnalysisResult {
  return {
    bestMove: '',
    evalCp: null,
    evalMate: null,
    pv: [],
    depth: 14,
    secondMove: null,
    secondEvalCp: null,
    secondEvalMate: null,
    ...a,
  };
}

describe('detectMissedTactic', () => {
  test('returns null when the played move already equals the best move', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'e4',
      uci: 'e2e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    };
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const result = detectMissedTactic(move, beforeFen, mkAnalysis({ bestMove: 'e2e4' }));
    expect(result).toBeNull();
  });

  test('detects a missed forced mate', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'Kd1',
      uci: 'e1d1',
      fenAfter: '4k3/8/8/8/8/8/8/3K4 b - - 0 1',
    };
    const beforeFen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const result = detectMissedTactic(move, beforeFen, mkAnalysis({ bestMove: 'e1f2', evalMate: 3 }), 3, null);
    expect(result?.motif).toBe('missed_mate');
  });

  test('detects a missed fork via the engine best move', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'Kd1',
      uci: 'e1d1',
      fenAfter: '4k3/r3b3/8/8/1N6/8/8/3K4 b - - 0 1',
    };
    const beforeFen = '4k3/r3b3/8/8/1N6/8/8/4K3 w - - 0 1';
    const result = detectMissedTactic(move, beforeFen, mkAnalysis({ bestMove: 'b4c6' }));
    expect(result?.motif).toBe('fork');
    expect(result?.motifDetail?.targets).toHaveLength(2);
  });

  test('detects a missed pin via the engine best move', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'Kd1',
      uci: 'e1d1',
      fenAfter: '7k/5q2/8/3n4/B7/8/8/3K4 b - - 0 1',
    };
    const beforeFen = '7k/5q2/8/3n4/B7/8/8/4K3 w - - 0 1';
    const result = detectMissedTactic(move, beforeFen, mkAnalysis({ bestMove: 'a4b3' }));
    expect(result?.motif).toBe('pin');
  });

  test('detects a missed skewer via the engine best move', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'Kd1',
      uci: 'e1d1',
      fenAfter: '8/5q2/8/3k4/B7/8/8/3K4 b - - 0 1',
    };
    const beforeFen = '8/5q2/8/3k4/B7/8/8/4K3 w - - 0 1';
    const result = detectMissedTactic(move, beforeFen, mkAnalysis({ bestMove: 'a4b3' }));
    expect(result?.motif).toBe('skewer');
  });
});

describe('detectNewlyHangingPiece', () => {
  test('flags a piece the move itself leaves attacked and undefended', () => {
    const beforeFen = '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1';
    const afterFen = '4k1r1/6B1/8/8/8/8/8/4K3 b - - 0 1';
    const before = new Chess(beforeFen);
    const after = new Chess(afterFen);
    const result = detectNewlyHangingPiece(before, after, 'c3g7', 'w');
    expect(result?.square).toBe('g7');
    expect(result?.value).toBe(3); // bishop
  });

  test('does not flag a piece moved to a fully safe square', () => {
    const beforeFen = '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1';
    const afterFen = '4k1r1/8/8/8/3B4/8/8/4K3 b - - 0 1';
    const before = new Chess(beforeFen);
    const after = new Chess(afterFen);
    const result = detectNewlyHangingPiece(before, after, 'c3d4', 'w');
    expect(result).toBeNull();
  });
});

describe('explainMove narration for the new classes', () => {
  const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const move: ParsedMove = {
    moveNumber: 1,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  };
  const analysis = mkAnalysis({ bestMove: 'e2e4', evalCp: 25 });

  test.each([
    ['brilliant', 'Brilliant!!'],
    ['great', 'Great move!'],
    ['book', 'Book move'],
    ['best', 'Best move'],
  ] as const)('%s gets its own title, not the generic fallback', (classification, expectedTitle) => {
    const explanation = explainMove(move, beforeFen, analysis, 0, classification, null, null);
    expect(explanation.title).toBe(expectedTitle);
  });

  test('an immediate checkmate is always narrated as Checkmate regardless of classification', () => {
    const mateMove: ParsedMove = {
      ...move,
      san: 'Ra8#',
      uci: 'a1a8',
      fenAfter: 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1',
    };
    const explanation = explainMove(
      mateMove,
      '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
      mkAnalysis({ bestMove: 'a1a8' }),
      0,
      'best',
      null,
      null,
    );
    expect(explanation.title).toBe('Checkmate');
    expect(explanation.motif).toBe('mate');
  });
});
