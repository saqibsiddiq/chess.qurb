import bookData from '../data/openingBook.json';
import { isBookMove } from './openingBook';
import type { ParsedGame } from './parsePgn';
import { uciToSan } from './explanations';

export interface OpeningInfo {
  eco: string | null;
  name: string | null;
}

export function nameFromEcoUrl(url: string): string | null {
  const slug = url.split('/openings/')[1];
  if (!slug) return null;

  const name = slug
    .split('...')[0]
    .replace(/-\d+\.[^-]*(?:-.*)?$/, '')
    .replace(/-/g, ' ')
    .trim();

  return name || null;
}

export function openingFrom(headers: Record<string, string>): OpeningInfo {
  const eco = headers.ECO?.trim() || null;

  const name =
    headers.Opening?.trim() ||
    (headers.ECOUrl ? nameFromEcoUrl(headers.ECOUrl) : null) ||
    null;

  return { eco, name };
}

export function bookExitPly(game: ParsedGame): number | null {
  for (let i = 0; i < game.moves.length; i++) {
    const fenBefore = i === 0 ? game.startingFen : game.moves[i - 1].fenAfter;
    if (!isBookMove(fenBefore, game.moves[i].uci)) return i;
  }
  return null;
}

export interface OpeningRecord {
  name: string;
  eco: string | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accuracy: number;
  averageBookExit: number | null;
  score: number;
}

interface OpeningSource {
  opening?: string | null;
  eco?: string | null;
  bookExitPly?: number | null;
  result: string;
  white: string;
  black: string;
  whiteAccuracy: number;
  blackAccuracy: number;
}

export function openingRecords(games: OpeningSource[], player: string): OpeningRecord[] {
  const byName = new Map<string, OpeningRecord & { exitTotal: number; exitCount: number }>();

  for (const g of games) {
    if (!g.opening) continue;
    const playedWhite = g.white === player;
    if (!playedWhite && g.black !== player) continue;

    const entry =
      byName.get(g.opening) ??
      {
        name: g.opening,
        eco: g.eco ?? null,
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        accuracy: 0,
        averageBookExit: null,
        score: 0,
        exitTotal: 0,
        exitCount: 0,
      };

    entry.games += 1;
    entry.accuracy += playedWhite ? g.whiteAccuracy : g.blackAccuracy;
    if (g.bookExitPly !== null && g.bookExitPly !== undefined) {
      entry.exitTotal += g.bookExitPly;
      entry.exitCount += 1;
    }

    if (g.result === '1/2-1/2') entry.draws += 1;
    else if (g.result === '1-0') playedWhite ? (entry.wins += 1) : (entry.losses += 1);
    else if (g.result === '0-1') playedWhite ? (entry.losses += 1) : (entry.wins += 1);

    byName.set(g.opening, entry);
  }

  return [...byName.values()]
    .map(({ exitTotal, exitCount, ...rec }) => ({
      ...rec,
      accuracy: rec.accuracy / rec.games,
      averageBookExit: exitCount > 0 ? exitTotal / exitCount : null,
      score: (rec.wins + rec.draws * 0.5) / rec.games,
    }))
    .sort((a, b) => b.games - a.games || b.score - a.score);
}

export function bookContinuations(fen: string): string[] {
  const book = bookData as Record<string, string[]>;
  const key = fen.split(' ').slice(0, 4).join(' ');
  return book[key] ?? [];
}

export interface OpeningLine {
  ply: number;
  san: string;
  inBook: boolean;
  alternatives: string[];
}

export function openingLine(
  game: ParsedGame,
  maxPlies = 20,
): OpeningLine[] {
  const rows: OpeningLine[] = [];
  const limit = Math.min(maxPlies, game.moves.length);

  for (let i = 0; i < limit; i++) {
    const fenBefore = i === 0 ? game.startingFen : game.moves[i - 1].fenAfter;
    const inBook = isBookMove(fenBefore, game.moves[i].uci);
    const alternatives = bookContinuations(fenBefore)
      .filter((uci) => uci !== game.moves[i].uci)
      .map((uci) => uciToSan(fenBefore, uci, ''))
      .filter(Boolean)
      .slice(0, 4);

    rows.push({ ply: i, san: game.moves[i].san, inBook, alternatives });
    if (!inBook) break;
  }

  return rows;
}
