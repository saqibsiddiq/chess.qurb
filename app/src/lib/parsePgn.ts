import { Chess } from 'chess.js';

export interface ParsedMove {
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  fenAfter: string;
  clock?: number;
}

export interface ParsedGame {
  headers: Record<string, string>;
  moves: ParsedMove[];
  startingFen: string;
}

function headersFromPgn(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const match of pgn.matchAll(/^\s*\[([^\s]+)\s+"([^"]*)"\]\s*$/gm)) {
    headers[match[1]] = match[2];
  }
  return headers;
}

function moveTokens(pgn: string): string[] {
  return pgn
    .replace(/^\s*\[[^\n]*\]\s*$/gm, '')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/(\d+)\.(\.\.)?/g, ' $1$2 ')
    .split(/\s+/)
    .filter(
      (token) =>
        token &&
        !/^\d+$/.test(token) &&
        !/^\d+\.{1,3}$/.test(token) &&
        !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token),
    );
}

function stripDisambiguation(san: string): string {
  return san.replace(/^([KQRBN])[a-h1-8]+(x?[a-h][1-8])/, '$1$2');
}

function loadTolerantPgn(
  pgn: string,
  startingFen: string,
): { headers: Record<string, string>; moves: ParsedMove[] } {
  const headers = headersFromPgn(pgn);
  const chess = new Chess(startingFen);
  const moves: ParsedMove[] = [];
  let moveNumber = Number(startingFen.split(' ')[5]) || 1;

  for (const token of moveTokens(pgn)) {
    const cleanToken = token.replace(/[!?]+$/, '').replace(/[+#]$/, '');
    let parsedMove: any = null;

    try {
      parsedMove = chess.move(token);
    } catch {
      try {
        parsedMove = chess.move(cleanToken);
      } catch {
        if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(cleanToken)) {
          try {
            parsedMove = chess.move({
              from: cleanToken.slice(0, 2),
              to: cleanToken.slice(2, 4),
              promotion: cleanToken[4] as any,
            });
          } catch {
          }
        }

        if (!parsedMove) {
          const legalMoves = chess.moves({ verbose: true });
          const strippedClean = stripDisambiguation(cleanToken);

          const candidates = legalMoves.filter((cand) => {
            const candClean = cand.san.replace(/[+#]$/, '');
            const candStripped = stripDisambiguation(candClean);
            return (
              candClean === cleanToken ||
              candStripped === strippedClean ||
              cand.san === cleanToken
            );
          });

          if (candidates.length === 1) {
            parsedMove = chess.move({
              from: candidates[0].from,
              to: candidates[0].to,
              promotion: candidates[0].promotion,
            });
          } else if (candidates.length > 1) {
            const origMatch = cleanToken.match(/^([KQRBN])([a-h1-8]+)/);
            if (origMatch) {
              const spec = origMatch[2];
              const matchingSpec = candidates.filter((c) => c.from.includes(spec));
              if (matchingSpec.length === 1) {
                parsedMove = chess.move({
                  from: matchingSpec[0].from,
                  to: matchingSpec[0].to,
                  promotion: matchingSpec[0].promotion,
                });
              }
            }
            if (!parsedMove) {
              parsedMove = chess.move({
                from: candidates[0].from,
                to: candidates[0].to,
                promotion: candidates[0].promotion,
              });
            }
          }
        }

        if (!parsedMove) {
          throw new Error(`Invalid or unparseable move in PGN: ${token}`);
        }
      }
    }

    const color = parsedMove.color;
    const currentMoveNumber = moveNumber;
    moves.push({
      moveNumber: currentMoveNumber,
      color,
      san: parsedMove.san,
      uci: `${parsedMove.from}${parsedMove.to}${parsedMove.promotion ?? ''}`,
      fenAfter: chess.fen(),
    });
    if (color === 'b') moveNumber += 1;
  }
  return { headers, moves };
}

function clocksByFen(chess: Chess): Map<string, number> {
  const byFen = new Map<string, number>();
  for (const { fen, comment } of chess.getComments()) {
    const match = comment.match(/\[%clk\s+([^\]]+)\]/);
    if (!match) continue;
    const seconds = parseClockText(match[1]);
    if (seconds !== null) byFen.set(fen, seconds);
  }
  return byFen;
}

function parseClockText(text: string): number | null {
  const m = text.match(/(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parsePgn(pgn: string): ParsedGame {
  const normalizedPgn = pgn
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();

  const chess = new Chess();
  let headers: Record<string, string>;
  let parsedMoves: ReturnType<Chess['history']>;

  try {
    chess.loadPgn(normalizedPgn, { strict: false, newlineChar: '\n' });
    headers = chess.getHeaders();
    parsedMoves = chess.history({ verbose: true });
  } catch {
    const rawHeaders = headersFromPgn(normalizedPgn);
    const fallbackStartingFen =
      rawHeaders.SetUp === '1' && rawHeaders.FEN ? rawHeaders.FEN : new Chess().fen();
    const tolerant = loadTolerantPgn(normalizedPgn, fallbackStartingFen);
    return {
      headers: tolerant.headers,
      moves: tolerant.moves,
      startingFen: fallbackStartingFen,
    };
  }

  const startingFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : new Chess().fen();
  const clocks = clocksByFen(chess);

  const replay = new Chess(startingFen);
  let moveNumber = Number(startingFen.split(' ')[5]) || 1;
  const moves: ParsedMove[] = parsedMoves.map((parsedMove) => {
    const color = replay.turn();
    const currentMoveNumber = moveNumber;
    const moveResult = replay.move(
      parsedMove.promotion
        ? { from: parsedMove.from, to: parsedMove.to, promotion: parsedMove.promotion }
        : { from: parsedMove.from, to: parsedMove.to },
    );
    const uci = `${moveResult.from}${moveResult.to}${moveResult.promotion ?? ''}`;
    if (color === 'b') moveNumber += 1;
    const fenAfter = replay.fen();
    return {
      moveNumber: currentMoveNumber,
      color,
      san: parsedMove.san,
      uci,
      fenAfter,
      clock: clocks.get(fenAfter),
    };
  });

  return {
    headers,
    moves,
    startingFen,
  };
}
