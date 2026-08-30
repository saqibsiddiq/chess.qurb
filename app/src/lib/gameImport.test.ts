import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchChessComGames, fetchLichessGames } from './gameImport';

function mockFetchOnce(response: Partial<Response> & { bodyText?: string }) {
  const { bodyText, ...rest } = response;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => bodyText ?? '',
    json: async () => (bodyText ? JSON.parse(bodyText) : {}),
    ...rest,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchLichessGames', () => {
  test('parses ndjson lines into game summaries', async () => {
    const line1 = JSON.stringify({
      id: 'abc123',
      createdAt: 1700000000000,
      speed: 'blitz',
      winner: 'white',
      players: { white: { user: { name: 'alice' }, rating: 1800 }, black: { user: { name: 'bob' }, rating: 1750 } },
      pgn: '1. e4 e5 *',
    });
    const line2 = JSON.stringify({
      id: 'def456',
      createdAt: 1700000100000,
      speed: 'rapid',
      status: 'draw',
      players: { white: { user: { name: 'carol' }, rating: 2000 }, black: { user: { name: 'dave' }, rating: 1990 } },
      pgn: '1. d4 d5 *',
    });
    mockFetchOnce({ bodyText: `${line1}\n${line2}\n` });

    const games = await fetchLichessGames('alice');
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({ id: 'abc123', white: 'alice', black: 'bob', result: '1-0', timeControl: 'blitz' });
    expect(games[1]).toMatchObject({ id: 'def456', result: '1/2-1/2' });
  });

  test('throws a friendly error on 404', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    await expect(fetchLichessGames('nobody')).rejects.toThrow('No Lichess account found');
  });

  test('throws when the username is blank', async () => {
    await expect(fetchLichessGames('   ')).rejects.toThrow('Enter a Lichess username');
  });

  test('throws a friendly error when the account has no games', async () => {
    mockFetchOnce({ bodyText: '' });
    await expect(fetchLichessGames('freshaccount')).rejects.toThrow('no games');
  });
});

describe('fetchChessComGames', () => {
  test('walks archives newest-first and normalizes results', async () => {
    const archives = { archives: ['https://api.chess.com/pub/player/alice/games/2024/01', 'https://api.chess.com/pub/player/alice/games/2024/02'] };
    const feb = {
      games: [
        {
          url: 'g1',
          uuid: 'g1-uuid',
          end_time: 1706745600,
          time_class: 'blitz',
          white: { username: 'alice', rating: 1800, result: 'win' },
          black: { username: 'bob', rating: 1750, result: 'resigned' },
          pgn: '1. e4 e5 *',
        },
      ],
    };

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => archives } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => feb } as Response);

    const games = await fetchChessComGames('alice', 1);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ id: 'g1-uuid', white: 'alice', black: 'bob', result: '1-0', timeControl: 'blitz' });
    // Stopped once `max` was reached, without walking further back to January.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('throws a friendly error on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchChessComGames('nobody')).rejects.toThrow('No Chess.com account found');
  });
});
