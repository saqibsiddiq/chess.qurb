import { describe, expect, test } from 'vitest';
import { aggregate, detectPlayer, insightsFor } from './insights';
import type { ReviewSummary } from './storage';

function summary(over: Partial<ReviewSummary>): ReviewSummary {
  return {
    id: Math.random().toString(16).slice(2),
    savedAt: 1,
    white: 'alice',
    black: 'bob',
    result: '1-0',
    date: '2026.09.01',
    moveCount: 40,
    whiteAccuracy: 80,
    blackAccuracy: 70,
    whiteCounts: {},
    blackCounts: {},
    whiteMotifs: {},
    blackMotifs: {},
    ...over,
  };
}

describe('detectPlayer', () => {
  test('picks the name that recurs across the library', () => {
    const games = [
      summary({ white: 'alice', black: 'bob' }),
      summary({ white: 'carol', black: 'alice' }),
      summary({ white: 'alice', black: 'dave' }),
    ];
    expect(detectPlayer(games)).toBe('alice');
  });

  test('ignores Unknown placeholders', () => {
    const games = [
      summary({ white: 'Unknown', black: 'Unknown' }),
      summary({ white: 'Unknown', black: 'zoe' }),
    ];
    expect(detectPlayer(games)).toBe('zoe');
  });

  test('returns null when there is nothing to go on', () => {
    expect(detectPlayer([])).toBeNull();
    expect(detectPlayer([summary({ white: 'Unknown', black: 'Unknown' })])).toBeNull();
  });
});

describe('aggregate', () => {
  test('reads the tallies for whichever colour the player had', () => {
    const games = [
      summary({
        white: 'alice',
        black: 'bob',
        whiteCounts: { blunder: 2, inaccuracy: 1 },
        blackCounts: { blunder: 9 },
        whiteMotifs: { hanging_piece: 2 },
        blackMotifs: { fork: 7 },
      }),
      summary({
        white: 'carol',
        black: 'alice',
        whiteCounts: { blunder: 5 },
        blackCounts: { blunder: 1, mistake: 3 },
        whiteMotifs: { pin: 4 },
        blackMotifs: { hanging_piece: 1 },
      }),
    ];

    const insights = aggregate(games, 'alice')!;

    expect(insights.games).toBe(2);
    expect(insights.perGame.blunder).toBeCloseTo(1.5, 5);
    expect(insights.perGame.mistake).toBeCloseTo(1.5, 5);
    expect(insights.weaknesses[0]).toMatchObject({ motif: 'hanging_piece', count: 3 });
    expect(insights.weaknesses.map((w) => w.motif)).not.toContain('fork');
  });

  test('scores results from the player’s own side', () => {
    const games = [
      summary({ white: 'alice', black: 'bob', result: '1-0' }),
      summary({ white: 'carol', black: 'alice', result: '1-0' }),
      summary({ white: 'alice', black: 'dave', result: '1/2-1/2' }),
      summary({ white: 'eve', black: 'alice', result: '0-1' }),
      summary({ white: 'alice', black: 'finn', result: '*' }),
    ];
    const insights = aggregate(games, 'alice')!;
    expect(insights).toMatchObject({ games: 5, wins: 2, draws: 1, losses: 1 });
  });

  test('averages accuracy from the correct side', () => {
    const games = [
      summary({ white: 'alice', whiteAccuracy: 90, blackAccuracy: 10 }),
      summary({ white: 'zed', black: 'alice', whiteAccuracy: 10, blackAccuracy: 70 }),
    ];
    expect(aggregate(games, 'alice')!.averageAccuracy).toBeCloseTo(80, 5);
  });

  test('excludes delivered checkmates from weaknesses', () => {
    const games = [
      summary({ white: 'alice', whiteMotifs: { mate: 3, hanging_piece: 1 } }),
    ];
    const insights = aggregate(games, 'alice')!;
    expect(insights.weaknesses.map((w) => w.motif)).toEqual(['hanging_piece']);
  });

  test('ranks weaknesses by frequency and reports a per-game rate', () => {
    const games = [
      summary({ white: 'alice', whiteMotifs: { fork: 1, hanging_piece: 4 } }),
      summary({ white: 'alice', whiteMotifs: { fork: 1 } }),
    ];
    const insights = aggregate(games, 'alice')!;
    expect(insights.weaknesses.map((w) => w.motif)).toEqual(['hanging_piece', 'fork']);
    expect(insights.weaknesses[0].perGame).toBeCloseTo(2, 5);
  });

  test('returns null when the player has no games', () => {
    expect(aggregate([summary({ white: 'x', black: 'y' })], 'alice')).toBeNull();
  });
});

describe('insightsFor', () => {
  test('detects the player and aggregates in one step', () => {
    const games = [
      summary({ white: 'alice', black: 'bob', whiteMotifs: { fork: 2 } }),
      summary({ white: 'alice', black: 'carol', whiteMotifs: { fork: 1 } }),
    ];
    expect(insightsFor(games)).toMatchObject({ player: 'alice', games: 2 });
  });

  test('returns null for an empty library', () => {
    expect(insightsFor([])).toBeNull();
  });
});
