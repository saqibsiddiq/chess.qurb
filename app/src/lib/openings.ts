import bookData from '../data/openingBook.json';
import { isBookMove } from './openingBook';
import type { ParsedGame } from './parsePgn';
import { uciToSan } from './explanations';

// Both platforms name the opening for free, in different shapes: Lichess
// sends a readable `Opening` header, Chess.com only an `ECOUrl` whose
// slug has to be unpicked. Normalising them here means the rest of the
// app never has to care which source a game came from.

export interface OpeningInfo {
  /** ECO code, e.g. `B02`. */
  eco: string | null;
  /** Human-readable name, e.g. `Alekhine Defense: Sämisch Attack`. */
  name: string | null;
}

/**
 * Turns a Chess.com `ECOUrl` into a readable name.
 *
 * The slug carries the opening name followed by the moves that define the
 * line, e.g. `Indian-Game-Spielmann-Indian-Variation...4.Nxd4-d5-5.Bg2-e5`.
 * Only the leading name is wanted — the move list is noise in a list of
 * openings, and it differs between transpositions that are otherwise the
 * same opening, which would fragment any grouping built on it.
 */
export function nameFromEcoUrl(url: string): string | null {
  const slug = url.split('/openings/')[1];
  if (!slug) return null;

  const name = slug
    // Everything from the move list onwards.
    .split('...')[0]
    // Some slugs append moves directly, as `-4.Nxd4`.
    .replace(/-\d+\.[^-]*(?:-.*)?$/, '')
    .replace(/-/g, ' ')
    .trim();

  return name || null;
}

export function openingFrom(headers: Record<string, string>): OpeningInfo {
  const eco = headers.ECO?.trim() || null;

  // Lichess supplies a proper name; Chess.com does not, so its slug is
  // unpicked. The ECO code alone is the last resort — it identifies the
  // opening without naming it, which is still better than nothing.
  const name =
    headers.Opening?.trim() ||
    (headers.ECOUrl ? nameFromEcoUrl(headers.ECOUrl) : null) ||
    null;

  return { eco, name };
}

/**
 * The ply at which the game left known theory, or `null` if it never did.
 *
 * Measured against Chesy's own mined opening book rather than the
 * platform's opening label: the label names whatever the opening
 * transposed into, while this answers the more useful question of where
 * the player stopped following moves that other players actually play.
 */
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
  /** Mean accuracy the player achieved in these games. */
  accuracy: number;
  /** Mean ply at which the player's games left book, when known. */
  averageBookExit: number | null;
  /** Points per game, 1 for a win and 0.5 for a draw — the figure that
   *  makes two openings comparable when they've been played different
   *  numbers of times. */
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

/**
 * Groups a player's games by opening, best-scoring first.
 *
 * Games whose opening could not be identified are dropped rather than
 * lumped into an "Unknown" bucket, which would look like a repertoire
 * choice the player had made.
 */
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

/**
 * The moves the corpus actually plays from a position, in the order the
 * book lists them.
 *
 * This is what makes an opening explainable offline: rather than linking
 * out to a database, the same mined book that decides "is this theory?"
 * can also answer "what comes next here?".
 */
export function bookContinuations(fen: string): string[] {
  const book = bookData as Record<string, string[]>;
  const key = fen.split(' ').slice(0, 4).join(' ');
  return book[key] ?? [];
}

export interface OpeningLine {
  /** Ply index, 0-based. */
  ply: number;
  san: string;
  /** Still inside the mined book at this point. */
  inBook: boolean;
  /** Other moves the corpus plays from the same position. */
  alternatives: string[];
}

/**
 * Walks the opening phase of a game, move by move, saying at each step
 * whether it was theory and what else was played there.
 *
 * Capped at the opening: past the point where the book runs out there is
 * nothing left to say about theory, and listing every later move would
 * bury the part that matters.
 */
export function openingLine(
  game: ParsedGame,
  maxPlies = 20,
): OpeningLine[] {
  const rows: OpeningLine[] = [];
  const limit = Math.min(maxPlies, game.moves.length);

  for (let i = 0; i < limit; i++) {
    const fenBefore = i === 0 ? game.startingFen : game.moves[i - 1].fenAfter;
    const inBook = isBookMove(fenBefore, game.moves[i].uci);
    // What else the corpus plays here, named in the notation the rest of
    // the app uses. The move actually played is excluded: it is already
    // the row's subject, and repeating it reads as an alternative to
    // itself.
    const alternatives = bookContinuations(fenBefore)
      .filter((uci) => uci !== game.moves[i].uci)
      .map((uci) => uciToSan(fenBefore, uci, ''))
      .filter(Boolean)
      .slice(0, 4);

    rows.push({ ply: i, san: game.moves[i].san, inBook, alternatives });
    // Once the game is out of book, later moves carry no theory meaning.
    if (!inBook) break;
  }

  return rows;
}
