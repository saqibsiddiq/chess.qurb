import { describe, expect, test } from 'vitest';
import { EMPTY_ACCURACY_ACCUMULATOR, finalizeAccuracy, reviewGame, reviewMove } from './reviewEngine';
import type { ParsedGame } from './parsePgn';
import type { AnalysisResult } from './analysis';

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

describe('reviewGame classification precedence', () => {
  test('a book-mined opening move is classified as book, not best', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'e4',
          uci: 'e2e4',
          fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'd2d4', evalCp: 30, secondEvalCp: 25 }),
      mkAnalysis({ bestMove: 'g8f6', evalCp: 27 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('book');
  });

  test('a sound sacrifice that ties the engine top move is brilliant', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Bg7',
          uci: 'c3g7',
          fenAfter: '4k1r1/6B1/8/8/8/8/8/4K3 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c3g7', evalCp: 400, secondEvalCp: 200 }),
      mkAnalysis({ bestMove: 'e8f7', evalCp: 350 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('brilliant');
  });

  test('the only good move (big gap, no sacrifice) is great', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Bd4',
          uci: 'c3d4',
          fenAfter: '4k1r1/8/8/8/3B4/8/8/4K3 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c3d4', evalCp: 400, secondEvalCp: 200 }),
      mkAnalysis({ bestMove: 'e8f7', evalCp: 395 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('great');
  });

  test('the engine top move with only a small gap to 2nd best is just best', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Bd4',
          uci: 'c3d4',
          fenAfter: '4k1r1/8/8/8/3B4/8/8/4K3 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c3d4', evalCp: 40, secondEvalCp: 35 }),
      mkAnalysis({ bestMove: 'e8f7', evalCp: 38 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('best');
  });

  test('a missed forced mate is classified as miss', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Kd1',
          uci: 'e1d1',
          fenAfter: '4k3/8/8/8/8/8/8/3K4 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'e1f2', evalMate: 3 }),
      mkAnalysis({ bestMove: 'e8d8', evalCp: 50 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('miss');
  });

  test('a mistake/blunder that specifically misses a fork the best move would have won is miss', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k3/r3b3/8/8/1N6/8/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Kd1',
          uci: 'e1d1',
          fenAfter: '4k3/r3b3/8/8/1N6/8/8/3K4 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'b4c6', evalCp: 300 }),
      mkAnalysis({ bestMove: 'e8d8', evalCp: -400 }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('miss');
  });

  test('a sole obvious recapture stays best even with a big eval gap to 2nd best', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '4k3/8/3p4/4p3/2N5/8/8/4K3 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Nxe5',
          uci: 'c4e5',
          fenAfter: '4k3/8/3p4/4N3/8/8/8/4K3 b - - 0 1',
        },
        {
          moveNumber: 1,
          color: 'b',
          san: 'dxe5',
          uci: 'd6e5',
          fenAfter: '4k3/8/8/4p3/8/8/8/4K3 w - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c4e5', evalCp: 0 }),
      mkAnalysis({ bestMove: 'd6e5', evalCp: 0, secondEvalCp: -300 }),
      mkAnalysis({ bestMove: 'e1d2', evalCp: -20 }),
    ];
    expect(reviewGame(game, analysis).moves[1].classification).toBe('best');
  });

  test('checkmate is always best regardless of engine data', () => {
    const game: ParsedGame = {
      headers: {},
      startingFen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
      moves: [
        {
          moveNumber: 1,
          color: 'w',
          san: 'Ra8#',
          uci: 'a1a8',
          fenAfter: 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1',
        },
      ],
    };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'a1a2', evalCp: 500 }),
      mkAnalysis({}),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe('best');
  });
});

describe('reviewGame severity ladder (no book/tactics involved)', () => {
  const startingFen = '4k3/8/8/8/8/8/8/2Q1K3 w - - 0 1';
  const move = {
    moveNumber: 1,
    color: 'w' as const,
    san: 'Kd1',
    uci: 'e1d1',
    fenAfter: '4k3/8/8/8/8/8/8/2QK4 b - - 0 1',
  };

  test.each([
    ['excellent', 400, 370],
    ['good', 400, 320],
    ['inaccuracy', 400, 250],
    ['mistake', 400, 130],
    ['blunder', 400, 20],
  ] as const)('classifies a %s-sized eval drop correctly', (expected, before, after) => {
    const game: ParsedGame = { headers: {}, startingFen, moves: [move] };
    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c1c8', evalCp: before }),
      mkAnalysis({ bestMove: 'e8d8', evalCp: after }),
    ];
    expect(reviewGame(game, analysis).moves[0].classification).toBe(expected);
  });
});

describe('reviewMove incremental classification matches a full reviewGame batch call', () => {
  test('classifying one move at a time, in order, produces the same result as reviewGame', () => {
    const startingFen = '4k3/8/8/8/8/8/8/2Q1K3 w - - 0 1';
    const game: ParsedGame = {
      headers: {},
      startingFen,
      moves: [
        { moveNumber: 1, color: 'w', san: 'Kd1', uci: 'e1d1', fenAfter: '4k3/8/8/8/8/8/8/2QK4 b - - 0 1' },
        { moveNumber: 1, color: 'b', san: 'Kd8', uci: 'e8d8', fenAfter: '3k4/8/8/8/8/8/8/2QK4 w - - 1 2' },
      ],
    };

    const analysis: AnalysisResult[] = [
      mkAnalysis({ bestMove: 'c1c8', evalCp: 400 }),
      mkAnalysis({ bestMove: 'd8e8', evalCp: 320 }),
      mkAnalysis({ bestMove: 'd1c2', evalCp: 200 }),
    ];

    const batch = reviewGame(game, analysis);

    let accumulator = EMPTY_ACCURACY_ACCUMULATOR;
    const incrementalMoves = [];
    for (let i = 0; i < game.moves.length; i++) {
      const result = reviewMove(game, i, analysis[i], analysis[i + 1], accumulator);
      incrementalMoves.push(result.reviewedMove);
      accumulator = result.accumulator;
    }
    const incrementalAccuracy = finalizeAccuracy(accumulator);

    expect(incrementalMoves.map((m) => m.classification)).toEqual(batch.moves.map((m) => m.classification));
    expect(incrementalMoves.map((m) => m.lossCp)).toEqual(batch.moves.map((m) => m.lossCp));
    expect(incrementalAccuracy).toEqual({ whiteAccuracy: batch.whiteAccuracy, blackAccuracy: batch.blackAccuracy });
  });
});
