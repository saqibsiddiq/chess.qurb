import { Chess } from 'chess.js';

export interface ParsedMove {
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  uci: string; // e.g. "e2e4", or "e7e8q" for a promotion
  fenAfter: string;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsedMove: any = null;

    // 1. Try standard move parsing with the raw token
    try {
      parsedMove = chess.move(token);
    } catch {
      // 2. Try with cleanToken (stripped of checks and annotations)
      try {
        parsedMove = chess.move(cleanToken);
      } catch {
        // 3. Try UCI move notation (e.g. e7c7 or e2e4)
        if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(cleanToken)) {
          try {
            parsedMove = chess.move({
              from: cleanToken.slice(0, 2),
              to: cleanToken.slice(2, 4),
              promotion: cleanToken[4] as any,
            });
          } catch {
            // ignore
          }
        }

        // 4. Try matching against legal moves with tolerant disambiguation (e.g. Rcc7 -> Rc7)
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
            // Check if cleanToken had an origin hint (e.g. rank or file like 'c' or '7')
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

/**
 * Turns a raw PGN string into a list of moves, each carrying the FEN
 * position that results from playing it, plus a UCI-style move string
 * (from+to+promotion).
 */
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

  // Replay the game move by move on a fresh board to capture FENs & UCI notations
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
    return {
      moveNumber: currentMoveNumber,
      color,
      san: parsedMove.san,
      uci,
      fenAfter: replay.fen(),
    };
  });

  return {
    headers,
    moves,
    startingFen,
  };
}
