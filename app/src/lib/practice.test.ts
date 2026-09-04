import { beforeEach, describe, expect, test, vi } from 'vitest';
import { applyAttempt, judgeAttempt } from './practice';
import type { AnalysisResult } from './analysis';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function analysis(a: Partial<AnalysisResult>): AnalysisResult {
  return {
    bestMove: '',
    evalCp: 0,
    evalMate: null,
    pv: [],
    depth: 14,
    secondMove: null,
    secondEvalCp: null,
    secondEvalMate: null,
    ...a,
  };
}

beforeEach(() => invokeMock.mockReset());

describe('applyAttempt', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  test('returns SAN and UCI for a legal move', () => {
    expect(applyAttempt(start, 'e2', 'e4')).toMatchObject({ uci: 'e2e4', san: 'e4', isCheckmate: false });
  });

  test('returns null for an illegal move', () => {
    expect(applyAttempt(start, 'e2', 'e5')).toBeNull();
  });

  test('auto-queens a promotion', () => {
    const promo = '8/P6k/8/8/8/8/8/7K w - - 0 1';
    expect(applyAttempt(promo, 'a7', 'a8')).toMatchObject({ uci: 'a7a8q', san: 'a8=Q' });
  });

  test('detects checkmate', () => {
    const mateIn1 = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
    expect(applyAttempt(mateIn1, 'a1', 'a8')).toMatchObject({ isCheckmate: true });
  });
});

describe('judgeAttempt', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  test('delivering mate scores best without consulting the engine', async () => {
    const mateIn1 = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
    const result = await judgeAttempt(mateIn1, 'a1', 'a8', analysis({ bestMove: 'a1a8' }), 12);
    expect(result).toMatchObject({ verdict: 'best', lossCp: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test('the engine move scores best', async () => {
    invokeMock.mockResolvedValue(analysis({ evalCp: 25 }));
    const result = await judgeAttempt(start, 'e2', 'e4', analysis({ bestMove: 'e2e4', evalCp: 30 }), 12);
    expect(result).toMatchObject({ verdict: 'best', isEngineMove: true });
  });

  test.each([
    [20, 'good'],
    [60, 'inaccurate'],
    [400, 'poor'],
  ])('a %icp drop for White scores %s', async (loss, verdict) => {
    invokeMock.mockResolvedValue(analysis({ evalCp: 100 - loss }));
    const result = await judgeAttempt(start, 'd2', 'd4', analysis({ bestMove: 'e2e4', evalCp: 100 }), 12);
    expect(result?.verdict).toBe(verdict);
    expect(result?.lossCp).toBeCloseTo(loss, 5);
  });

  test('scores a drop correctly when Black is to move', async () => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    invokeMock.mockResolvedValue(analysis({ evalCp: 300 }));
    const result = await judgeAttempt(
      blackToMove,
      'a7',
      'a5',
      analysis({ bestMove: 'e7e5', evalCp: 0 }),
      12,
    );
    expect(result?.lossCp).toBeCloseTo(300, 5);
    expect(result?.verdict).toBe('poor');
  });

  test('an improvement is never a negative loss', async () => {
    invokeMock.mockResolvedValue(analysis({ evalCp: 500 }));
    const result = await judgeAttempt(start, 'd2', 'd4', analysis({ bestMove: 'e2e4', evalCp: 100 }), 12);
    expect(result?.lossCp).toBe(0);
    expect(result?.verdict).toBe('good');
  });

  test('explains a hanging piece rather than only scoring it', async () => {
    const beforeFen = '4k1r1/8/8/8/8/2B5/8/4K3 w - - 0 1';
    invokeMock.mockResolvedValue(analysis({ evalCp: -300 }));
    const result = await judgeAttempt(beforeFen, 'c3', 'g7', analysis({ bestMove: 'c3d4', evalCp: 0 }), 12);
    expect(result?.reason).toBe('That leaves your bishop on g7 hanging to the rook on g8.');
  });

  test('calls out walking into a forced mate', async () => {
    const beforeFen = '2r3k1/pp3pp1/4p2p/4Pn2/8/P4N2/1P1r1PPP/3R2K1 w - - 0 23';
    invokeMock.mockResolvedValue(analysis({ evalCp: null, evalMate: -3 }));
    const result = await judgeAttempt(beforeFen, 'd1', 'd2', analysis({ bestMove: 'f3d2', evalCp: -180 }), 12);
    expect(result?.reason).toBe('That allows a forced mate in 3.');
  });

  test('says nothing extra when the attempt was fine', async () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    invokeMock.mockResolvedValue(analysis({ evalCp: 95 }));
    const result = await judgeAttempt(start, 'd2', 'd4', analysis({ bestMove: 'e2e4', evalCp: 100 }), 12);
    expect(result?.verdict).toBe('good');
    expect(result?.reason).toBeUndefined();
  });

  test('returns null for an illegal attempt rather than calling the engine', async () => {
    const result = await judgeAttempt(start, 'e2', 'e5', analysis({ bestMove: 'e2e4' }), 12);
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
