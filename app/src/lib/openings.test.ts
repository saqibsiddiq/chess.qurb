import { describe, expect, test } from 'vitest';
import { bookExitPly, nameFromEcoUrl, openingFrom, openingRecords } from './openings';
import { parsePgn } from './parsePgn';

describe('nameFromEcoUrl', () => {
  test('keeps the name and drops the move list', () => {
    expect(
      nameFromEcoUrl(
        'https://www.chess.com/openings/Indian-Game-Spielmann-Indian-Variation...4.Nxd4-d5-5.Bg2-e5',
      ),
    ).toBe('Indian Game Spielmann Indian Variation');
  });

  test('drops a move list appended without an ellipsis', () => {
    expect(nameFromEcoUrl('https://www.chess.com/openings/Kings-Pawn-Opening-2.d4-exd4')).toBe(
      'Kings Pawn Opening',
    );
  });

  test('handles a bare opening name', () => {
    expect(nameFromEcoUrl('https://www.chess.com/openings/Sicilian-Defense')).toBe(
      'Sicilian Defense',
    );
  });

  test('returns null for a URL with no opening segment', () => {
    expect(nameFromEcoUrl('https://www.chess.com/game/live/123')).toBeNull();
  });
});

describe('openingFrom', () => {
  test('prefers a supplied name (Lichess)', () => {
    expect(openingFrom({ ECO: 'B02', Opening: 'Alekhine Defense: Sämisch Attack' })).toEqual({
      eco: 'B02',
      name: 'Alekhine Defense: Sämisch Attack',
    });
  });

  test('falls back to unpicking the Chess.com slug', () => {
    expect(
      openingFrom({ ECO: 'A46', ECOUrl: 'https://www.chess.com/openings/Indian-Game...3.Nc3' }),
    ).toEqual({ eco: 'A46', name: 'Indian Game' });
  });

  test('keeps the ECO code even when no name can be found', () => {
    expect(openingFrom({ ECO: 'C20' })).toEqual({ eco: 'C20', name: null });
  });

  test('reports nothing for a PGN with no opening headers', () => {
    expect(openingFrom({})).toEqual({ eco: null, name: null });
  });
});

describe('bookExitPly', () => {
  test('reports the first move outside the mined book', () => {
    const game = parsePgn('1. e4 e5 2. Nf3 Nc6 *');
    const exit = bookExitPly(game);
    expect(exit === null || exit > 0).toBe(true);
  });

  test('an immediately offbeat move leaves book at once', () => {
    const game = parsePgn('1. Na3 e5 *');
    expect(bookExitPly(game)).toBe(0);
  });

  test('returns null for an empty game rather than a misleading zero', () => {
    expect(bookExitPly(parsePgn('*'))).toBeNull();
  });
});

describe('openingRecords', () => {
  const games = [
    { opening: 'Sicilian Defense', eco: 'B20', bookExitPly: 6, result: '1-0', white: 'me', black: 'a', whiteAccuracy: 80, blackAccuracy: 60 },
    { opening: 'Sicilian Defense', eco: 'B20', bookExitPly: 8, result: '0-1', white: 'b', black: 'me', whiteAccuracy: 50, blackAccuracy: 90 },
    { opening: 'Sicilian Defense', eco: 'B20', bookExitPly: null, result: '1/2-1/2', white: 'me', black: 'c', whiteAccuracy: 70, blackAccuracy: 70 },
    { opening: 'French Defense', eco: 'C00', bookExitPly: 4, result: '0-1', white: 'me', black: 'd', whiteAccuracy: 40, blackAccuracy: 88 },
  ];

  test('scores results from the player’s own side', () => {
    const [sicilian] = openingRecords(games, 'me');
    expect(sicilian).toMatchObject({ name: 'Sicilian Defense', games: 3, wins: 2, draws: 1, losses: 0 });
    expect(sicilian.score).toBeCloseTo(2.5 / 3, 5);
  });

  test('averages accuracy from the colour the player had', () => {
    const [sicilian] = openingRecords(games, 'me');
    expect(sicilian.accuracy).toBeCloseTo(80, 5);
  });

  test('averages book exit over only the games that recorded one', () => {
    const [sicilian] = openingRecords(games, 'me');
    expect(sicilian.averageBookExit).toBeCloseTo(7, 5);
  });

  test('drops games whose opening is unknown', () => {
    const withUnknown = [...games, { opening: null, eco: null, bookExitPly: 3, result: '1-0', white: 'me', black: 'z', whiteAccuracy: 99, blackAccuracy: 1 }];
    const total = openingRecords(withUnknown, 'me').reduce((n, r) => n + r.games, 0);
    expect(total).toBe(4);
  });

  test('ignores games the player did not play in', () => {
    expect(openingRecords(games, 'nobody')).toEqual([]);
  });

  test('orders by how often the opening was played', () => {
    const records = openingRecords(games, 'me');
    expect(records.map((r) => r.name)).toEqual(['Sicilian Defense', 'French Defense']);
  });
});
