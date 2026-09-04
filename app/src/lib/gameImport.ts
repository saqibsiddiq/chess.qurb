import type { LichessAnalysisEntry } from './lichessAnalysis';

export type RemoteProvider = 'lichess' | 'chesscom';

export interface RemoteGameSummary {
  analysis?: LichessAnalysisEntry[];
  id: string;
  white: string;
  black: string;
  whiteRating: number | null;
  blackRating: number | null;
  result: string;
  date: string;
  timeControl: string | null;
  pgn: string;
}

class GameImportError extends Error {}

export const DEFAULT_MAX_GAMES = 100;

const REQUEST_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}

function networkError(err: unknown, service: string): GameImportError {
  const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
  return new GameImportError(
    timedOut
      ? `${service} took too long to respond. Check your connection and try again.`
      : `Could not reach ${service}. Check your connection and try again.`,
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface LichessPlayer {
  user?: { name?: string };
  rating?: number;
  aiLevel?: number;
}

interface LichessGame {
  id: string;
  createdAt: number;
  speed?: string;
  winner?: 'white' | 'black';
  status?: string;
  players?: { white?: LichessPlayer; black?: LichessPlayer };
  pgn?: string;
  analysis?: LichessAnalysisEntry[];
}

function lichessPlayerName(player: LichessPlayer | undefined): string {
  if (!player) return 'Anonymous';
  if (player.user?.name) return player.user.name;
  if (player.aiLevel != null) return `Stockfish level ${player.aiLevel}`;
  return 'Anonymous';
}

function lichessResult(game: LichessGame): string {
  if (game.status === 'draw' || game.status === 'stalemate') return '1/2-1/2';
  if (game.winner === 'white') return '1-0';
  if (game.winner === 'black') return '0-1';
  return '*';
}

export async function fetchLichessGames(username: string, max = DEFAULT_MAX_GAMES): Promise<RemoteGameSummary[]> {
  const trimmed = username.trim();
  if (!trimmed) throw new GameImportError('Enter a Lichess username.');

  const url = `https://lichess.org/api/games/user/${encodeURIComponent(trimmed)}?max=${max}&pgnInJson=true&opening=true&evals=true`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/x-ndjson' } });
  } catch (err) {
    throw networkError(err, 'Lichess');
  }

  if (res.status === 404) throw new GameImportError(`No Lichess account found for "${trimmed}".`);
  if (res.status === 429) throw new GameImportError('Lichess is rate-limiting requests right now. Wait a moment and try again.');
  if (!res.ok) throw new GameImportError(`Lichess request failed (${res.status}).`);

  const text = await res.text();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new GameImportError(`"${trimmed}" has no games on Lichess yet.`);

  return lines.map((line) => {
    const g: LichessGame = JSON.parse(line);
    return {
      id: g.id,
      white: lichessPlayerName(g.players?.white),
      black: lichessPlayerName(g.players?.black),
      whiteRating: g.players?.white?.rating ?? null,
      blackRating: g.players?.black?.rating ?? null,
      result: lichessResult(g),
      date: formatDate(g.createdAt),
      timeControl: g.speed ?? null,
      pgn: g.pgn ?? '',
      analysis: g.analysis,
    };
  });
}

interface ChessComPlayer {
  username?: string;
  rating?: number;
  result?: string;
}

interface ChessComGame {
  url: string;
  uuid?: string;
  pgn?: string;
  end_time: number;
  time_class?: string;
  white?: ChessComPlayer;
  black?: ChessComPlayer;
}

function chessComResult(game: ChessComGame): string {
  if (game.white?.result === 'win') return '1-0';
  if (game.black?.result === 'win') return '0-1';
  return '1/2-1/2';
}

export async function fetchChessComGames(username: string, max = DEFAULT_MAX_GAMES): Promise<RemoteGameSummary[]> {
  const trimmed = username.trim();
  if (!trimmed) throw new GameImportError('Enter a Chess.com username.');
  const handle = encodeURIComponent(trimmed.toLowerCase());

  let archivesRes: Response;
  try {
    archivesRes = await fetchWithTimeout(`https://api.chess.com/pub/player/${handle}/games/archives`);
  } catch (err) {
    throw networkError(err, 'Chess.com');
  }
  if (archivesRes.status === 404) throw new GameImportError(`No Chess.com account found for "${trimmed}".`);
  if (!archivesRes.ok) throw new GameImportError(`Chess.com request failed (${archivesRes.status}).`);

  const { archives } = (await archivesRes.json()) as { archives: string[] };
  if (!archives?.length) throw new GameImportError(`"${trimmed}" has no games on Chess.com yet.`);

  const games: RemoteGameSummary[] = [];
  let batchSize = 1;
  for (let i = archives.length - 1; i >= 0 && games.length < max; i -= batchSize, batchSize = 3) {
    const batch: string[] = [];
    for (let k = i; k > i - batchSize && k >= 0; k--) batch.push(archives[k]);

    const responses = await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await fetchWithTimeout(url);
          if (!res.ok) return null;
          return (await res.json()) as { games: ChessComGame[] };
        } catch {
          return null;
        }
      }),
    );

    for (const payload of responses) {
      if (!payload?.games) continue;
      for (let j = payload.games.length - 1; j >= 0 && games.length < max; j--) {
        const g = payload.games[j];
        if (!g.pgn) continue;
        games.push({
          id: g.uuid ?? g.url,
          white: g.white?.username ?? 'Unknown',
          black: g.black?.username ?? 'Unknown',
          whiteRating: g.white?.rating ?? null,
          blackRating: g.black?.rating ?? null,
          result: chessComResult(g),
          date: formatDate(g.end_time * 1000),
          timeControl: g.time_class ?? null,
          pgn: g.pgn,
        });
      }
      if (games.length >= max) break;
    }
  }

  if (games.length === 0) throw new GameImportError(`"${trimmed}" has no completed games with PGN available.`);
  return games;
}

export async function fetchRemoteGames(provider: RemoteProvider, username: string): Promise<RemoteGameSummary[]> {
  return provider === 'lichess' ? fetchLichessGames(username) : fetchChessComGames(username);
}
