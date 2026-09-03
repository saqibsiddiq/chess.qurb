import { describe, expect, test } from 'vitest';
import { Chess } from 'chess.js';
import { describeThreat, detectMissedTactic, detectNewlyHangingPiece, explainMove } from './explanations';
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

describe('explainMove arrow coherence', () => {
  test('a missed fork draws the move that creates it, not just its targets', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'Kd1',
      uci: 'e1d1',
      fenAfter: '4k3/r3b3/8/8/1N6/8/8/3K4 b - - 0 1',
    };
    const beforeFen = '4k3/r3b3/8/8/1N6/8/8/4K3 w - - 0 1';
    const analysis = mkAnalysis({ bestMove: 'b4c6', evalCp: 300 });
    const missedTactic = detectMissedTactic(move, beforeFen, analysis);
    expect(missedTactic?.motif).toBe('fork');

    const explanation = explainMove(move, beforeFen, analysis, 400, 'blunder', null, missedTactic);

    // The fork's arrows fan out from c6 — the square the knight would
    // land on. In the position actually on screen that square is empty,
    // so on its own the fan appears to come from nowhere. The best move
    // has to be drawn too, or the tactic is not explicable: green gets a
    // piece to c6, yellow shows what it hits from there.
    const best = explanation.shapes.find((s) => s.brush === 'green');
    expect(best).toEqual({ orig: 'b4', dest: 'c6', brush: 'green' });

    const targets = explanation.shapes.filter((s) => s.brush === 'yellow');
    expect(targets).toHaveLength(2);
    expect(targets.every((s) => s.orig === 'c6')).toBe(true);

    // Still restrained: one move plus its two targets, nothing else.
    expect(explanation.shapes).toHaveLength(3);
  });

  test('a plain evaluation swing contrasts the move played with the better one', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'a3',
      uci: 'a2a3',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
    };
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const analysis = mkAnalysis({ bestMove: 'e2e4', evalCp: 30 });

    const explanation = explainMove(move, beforeFen, analysis, 120, 'inaccuracy', null, null);

    // Blue is what you did, green is what was better — two arrows answer
    // a question one cannot.
    expect(explanation.shapes).toContainEqual({ orig: 'a2', dest: 'a3', brush: 'blue' });
    expect(explanation.shapes).toContainEqual({ orig: 'e2', dest: 'e4', brush: 'green' });
  });

  test('says nothing twice when the move played was the best one', () => {
    const move: ParsedMove = {
      moveNumber: 1,
      color: 'w',
      san: 'e4',
      uci: 'e2e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    };
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const analysis = mkAnalysis({ bestMove: 'e2e4', evalCp: 30 });

    const explanation = explainMove(move, beforeFen, analysis, 0, 'best', null, null);
    expect(explanation.shapes.filter((s) => s.brush === 'blue')).toHaveLength(0);
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

  test('a positive move that IS the engine\'s top choice gets no arrow (nothing to point to)', () => {
    const explanation = explainMove(move, beforeFen, analysis, 0, 'best', null, null);
    expect(explanation.shapes).toEqual([]);
  });

  test('a positive move that is NOT the engine\'s top choice gets exactly one arrow to it', () => {
    const differentBest = mkAnalysis({ bestMove: 'd2d4', evalCp: 25 });
    const explanation = explainMove(move, beforeFen, differentBest, 10, 'excellent', null, null);
    expect(explanation.shapes).toEqual([{ orig: 'd2', dest: 'd4', brush: 'green' }]);
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

describe('describeThreat', () => {
  test('names a piece the side to move can simply take', () => {
    // Black to move; White's bishop on g7 is attacked by the rook on g8
    // and defended by nothing.
    const threat = describeThreat('4k1r1/6B1/8/8/8/8/8/4K3 b - - 0 1');
    expect(threat).toBe('Your bishop on g7 is undefended and can be taken.');
  });

  test('describes the threat against whoever is *not* to move', () => {
    // Same position with White to move: the loose bishop is White's own,
    // so there is nothing to warn White about and the result is null —
    // the threat always belongs to the side *not* on move.
    expect(describeThreat('4k1r1/6B1/8/8/8/8/8/4K3 w - - 0 1')).toBeNull();
  });

  test('says nothing when there is nothing concrete to warn about', () => {
    expect(describeThreat('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBeNull();
  });

  test('returns null for an unparseable position rather than throwing', () => {
    expect(describeThreat('not-a-fen')).toBeNull();
  });
});
