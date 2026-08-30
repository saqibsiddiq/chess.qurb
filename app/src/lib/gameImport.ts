export type RemoteProvider = 'lichess' | 'chesscom';

export interface RemoteGameSummary {
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

export async function fetchLichessGames(username: string, max = 20): Promise<RemoteGameSummary[]> {
  const trimmed = username.trim();
  if (!trimmed) throw new GameImportError('Enter a Lichess username.');

  const url = `https://lichess.org/api/games/user/${encodeURIComponent(trimmed)}?max=${max}&pgnInJson=true&opening=false`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
  } catch {
    throw new GameImportError('Could not reach Lichess. Check your connection and try again.');
  }

  if (res.status === 404) throw new GameImportError(`No Lichess account found for "${trimmed}".`);
  if (res.status === 429) throw new GameImportError('Lichess is rate-limiting requests right now — wait a moment and try again.');
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

export async function fetchChessComGames(username: string, max = 20): Promise<RemoteGameSummary[]> {
  const trimmed = username.trim();
  if (!trimmed) throw new GameImportError('Enter a Chess.com username.');
  const handle = encodeURIComponent(trimmed.toLowerCase());

  let archivesRes: Response;
  try {
    archivesRes = await fetch(`https://api.chess.com/pub/player/${handle}/games/archives`);
  } catch {
    throw new GameImportError('Could not reach Chess.com. Check your connection and try again.');
  }
  if (archivesRes.status === 404) throw new GameImportError(`No Chess.com account found for "${trimmed}".`);
  if (!archivesRes.ok) throw new GameImportError(`Chess.com request failed (${archivesRes.status}).`);

  const { archives } = (await archivesRes.json()) as { archives: string[] };
  if (!archives?.length) throw new GameImportError(`"${trimmed}" has no games on Chess.com yet.`);

  const games: RemoteGameSummary[] = [];
  // Archives are chronological (oldest first) — walk backwards from the
  // most recent month so users see their latest games, not their oldest.
  for (let i = archives.length - 1; i >= 0 && games.length < max; i--) {
    let monthRes: Response;
    try {
      monthRes = await fetch(archives[i]);
    } catch {
      continue;
    }
    if (!monthRes.ok) continue;
    const { games: monthGames } = (await monthRes.json()) as { games: ChessComGame[] };
    for (let j = monthGames.length - 1; j >= 0 && games.length < max; j--) {
      const g = monthGames[j];
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
  }

  if (games.length === 0) throw new GameImportError(`"${trimmed}" has no completed games with PGN available.`);
  return games;
}

export async function fetchRemoteGames(provider: RemoteProvider, username: string): Promise<RemoteGameSummary[]> {
  return provider === 'lichess' ? fetchLichessGames(username) : fetchChessComGames(username);
}
