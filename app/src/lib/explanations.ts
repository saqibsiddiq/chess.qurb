import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { AnalysisResult } from './analysis';
import type { ParsedMove } from './parsePgn';

export interface BoardShape {
  orig: string;
  dest?: string;
  brush: 'green' | 'red' | 'blue' | 'yellow';
}

export type TacticalMotif =
  | 'none'
  | 'mate'
  | 'missed_mate'
  | 'allowed_mate'
  | 'hanging_piece'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discovered_attack'
  | 'back_rank'
  | 'positive'
  | 'evaluation';

export interface MoveExplanation {
  title: string;
  summary: string;
  detail: string;
  motif: TacticalMotif;
  motifDetail?: Record<string, unknown>;
  shapes: BoardShape[];
}

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

function moveFromUci(uci: string): { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } | null {
  if (uci.length < 4) return null;
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
  };
}

export function uciToSan(fen: string, uci: string, fallback = 'another move'): string {
  const move = moveFromUci(uci);
  if (!move) return fallback;
  try {
    return new Chess(fen).move(move).san;
  } catch {
    return fallback;
  }
}

export function pvToSan(fen: string, pv: string[]): string[] {
  const chess = new Chess(fen);
  const sanMoves: string[] = [];
  for (const uci of pv) {
    const move = moveFromUci(uci);
    if (!move) break;
    try {
      sanMoves.push(chess.move(move).san);
    } catch {
      break;
    }
  }
  return sanMoves;
}

function formatLoss(lossCp: number): string {
  return (lossCp / 100).toFixed(2);
}

function squareToCoords(sq: Square): [number, number] {
  const file = sq.charCodeAt(0) - 97; // 'a' -> 0
  const rank = sq.charCodeAt(1) - 49; // '1' -> 0
  return [file, rank];
}

function coordsToSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Square;
}

function getDirections(pieceType: PieceSymbol): [number, number][] {
  const diagonal: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const straight: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  if (pieceType === 'b') return diagonal;
  if (pieceType === 'r') return straight;
  if (pieceType === 'q') return [...diagonal, ...straight];
  return [];
}

function findNextPieceAlongRay(
  board: Chess,
  start: Square,
  direction: [number, number],
): { square: Square; piece: { type: PieceSymbol; color: Color } } | null {
  let [file, rank] = squareToCoords(start);
  file += direction[0];
  rank += direction[1];
  while (file >= 0 && file <= 7 && rank >= 0 && rank <= 7) {
    const sq = coordsToSquare(file, rank);
    if (sq) {
      const piece = board.get(sq);
      if (piece) return { square: sq, piece };
    }
    file += direction[0];
    rank += direction[1];
  }
  return null;
}

interface LineMotifResult {
  type: 'pin' | 'skewer';
  attackerSquare: Square;
  frontSquare: Square;
  frontPiece: string;
  behindSquare: Square;
  behindPiece: string;
}

function detectLineMotif(board: Chess, start: Square, color: Color): LineMotifResult | null {
  const attacker = board.get(start);
  if (!attacker || attacker.color !== color) return null;
  if (!['b', 'r', 'q'].includes(attacker.type)) return null;

  const enemy: Color = color === 'w' ? 'b' : 'w';

  for (const direction of getDirections(attacker.type)) {
    const frontResult = findNextPieceAlongRay(board, start, direction);
    if (!frontResult || frontResult.piece.color !== enemy) continue;

    const behindResult = findNextPieceAlongRay(board, frontResult.square, direction);
    if (!behindResult || behindResult.piece.color !== enemy) continue;

    // A pin is a line attack on an enemy piece with a more valuable
    // enemy piece behind it. King/queen/rook are the high-priority targets
    // used by this dataset's motif vocabulary.
    if (['k', 'q', 'r'].includes(behindResult.piece.type)) {
      return {
        type: 'pin',
        attackerSquare: start,
        frontSquare: frontResult.square,
        frontPiece: PIECE_NAMES[frontResult.piece.type],
        behindSquare: behindResult.square,
        behindPiece: PIECE_NAMES[behindResult.piece.type],
      };
    }

    // A skewer is the reverse ordering: king in front, valuable piece behind.
    if (frontResult.piece.type === 'k' && behindResult.piece.type !== 'p') {
      return {
        type: 'skewer',
        attackerSquare: start,
        frontSquare: frontResult.square,
        frontPiece: 'king',
        behindSquare: behindResult.square,
        behindPiece: PIECE_NAMES[behindResult.piece.type],
      };
    }
  }

  return null;
}

function detectDiscoveredAttack(
  boardBefore: Chess,
  boardAfter: Chess,
  move: { from: Square; to: Square },
  color: Color,
): { attackerSquare: Square; targetSquare: Square; targetPiece: string } | null {
  const enemy: Color = color === 'w' ? 'b' : 'w';
  const squares = boardAfter.board().flat().filter((p): p is NonNullable<typeof p> => p !== null);

  for (const item of squares) {
    if (item.color !== enemy || item.type === 'p') continue;

    const square = item.square;
    const attackersAfter = boardAfter.attackers(square, color);
    const attackersBefore = boardBefore.attackers(square, color);

    const newAttackers = attackersAfter.filter(
      (attackerSquare) => !attackersBefore.includes(attackerSquare) && attackerSquare !== move.to,
    );

    for (const attackerSquare of newAttackers) {
      const piece = boardAfter.get(attackerSquare);
      if (piece && ['b', 'r', 'q'].includes(piece.type)) {
        return {
          attackerSquare,
          targetSquare: square,
          targetPiece: PIECE_NAMES[item.type],
        };
      }
    }
  }

  return null;
}

function detectBackRank(board: Chess, color: Color): { kingSquare: Square } | null {
  const enemy: Color = color === 'w' ? 'b' : 'w';
  if (!board.isCheck()) return null;

  const enemyKing = board.board().flat().find(
    (p) => p && p.type === 'k' && p.color === enemy,
  );
  if (!enemyKing) return null;

  const [_, rank] = squareToCoords(enemyKing.square);
  const backRank = enemy === 'w' ? 0 : 7;
  if (rank !== backRank) return null;

  // Require a rook/queen checking line. This avoids classifying ordinary
  // knight/bishop checks on the back rank as back-rank motifs.
  const checkers = board.attackers(enemyKing.square, enemy === 'w' ? 'b' : 'w');
  const hasSlidingChecker = checkers.some((square) => {
    const piece = board.get(square);
    return piece && ['r', 'q'].includes(piece.type);
  });
  if (!hasSlidingChecker) return null;

  const kingMoves = board.moves({ verbose: true }).filter(
    (m) => m.piece === 'k' && m.color === enemy,
  );
  if (kingMoves.length > 0) return null;

  // Require the king zone to be substantially occupied by its own pieces.
  const [kingFile, kingRank] = squareToCoords(enemyKing.square);
  let friendlyBlockers = 0;

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const file = kingFile + df;
      const r = kingRank + dr;
      if (file < 0 || file > 7 || r < 0 || r > 7) continue;
      const square = coordsToSquare(file, r);
      if (square) {
        const piece = board.get(square);
        if (piece && piece.color === enemy) friendlyBlockers += 1;
      }
    }
  }

  if (friendlyBlockers < 3) return null;
  return { kingSquare: enemyKing.square };
}

function detectNewlyHangingPiece(
  before: Chess,
  after: Chess,
  playedUci: string,
  color: Color,
): { square: Square; name: string; attackerSquare?: Square } | null {
  const opponent: Color = color === 'w' ? 'b' : 'w';
  const move = moveFromUci(playedUci);
  const movedTo = move?.to;
  const pieces = after.board().flat().filter((p): p is NonNullable<typeof p> => p !== null);

  for (const piece of pieces) {
    if (piece.color !== color || piece.type === 'k') continue;

    const square = piece.square;
    const attackers = after.attackers(square, opponent);
    const defenders = after.attackers(square, color);

    // Conservative definition: attacked and completely undefended.
    if (attackers.length === 0 || defenders.length > 0) continue;

    const wasAttackers = before.attackers(square, opponent);
    const wasDefenders = before.attackers(square, color);
    const wasHanging = wasAttackers.length > 0 && wasDefenders.length === 0;

    // Only report a newly-created hanging piece. This prevents unrelated
    // pre-existing weaknesses from being blamed on the current move.
    if (wasHanging) continue;

    // If the move placed the piece there, or changed another piece so that
    // it became newly undefended/attacked, this is a causal result of the move.
    if (square === movedTo || attackers.some((a) => !wasAttackers.includes(a)) ||
        wasDefenders.length > 0) {
      return {
        square,
        name: PIECE_NAMES[piece.type],
        attackerSquare: attackers[0],
      };
    }
  }

  return null;
}

function detectFork(
  board: Chess,
  square: Square,
  color: Color,
): { targets: { square: Square; name: string }[] } | null {
  const piece = board.get(square);
  if (!piece) return null;
  const opponent: Color = color === 'w' ? 'b' : 'w';

  // Find all attacked squares from this piece
  const attackedSquares: Square[] = [];
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const targetSq = coordsToSquare(f, r);
      if (targetSq && board.attackers(targetSq, color).includes(square)) {
        attackedSquares.push(targetSq);
      }
    }
  }

  const targets = attackedSquares
    .map((sq) => {
      const targetPiece = board.get(sq);
      if (targetPiece && targetPiece.color === opponent && targetPiece.type !== 'p') {
        return { square: sq, name: PIECE_NAMES[targetPiece.type] };
      }
      return null;
    })
    .filter((t): t is { square: Square; name: string } => t !== null);

  if (targets.length >= 2) {
    return { targets };
  }
  return null;
}

export function explainMove(
  move: ParsedMove,
  beforeFen: string,
  analysisBefore: AnalysisResult,
  lossCp: number,
  classification: 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder',
  evalBeforeMate?: number | null,
  evalAfterMate?: number | null,
): MoveExplanation {
  const bestSan = uciToSan(beforeFen, analysisBefore.bestMove);
  const lossText = formatLoss(lossCp);
  const beforeBoard = new Chess(beforeFen);
  const afterBoard = new Chess(move.fenAfter);
  const isWhite = move.color === 'w';

  const shapes: BoardShape[] = [];

  // Add green arrow for engine best move
  const bestMove = moveFromUci(analysisBefore.bestMove);
  if (bestMove) {
    shapes.push({
      orig: bestMove.from,
      dest: bestMove.to,
      brush: 'green',
    });
  }

  // 1. Immediate Checkmate Played
  if (afterBoard.isCheckmate()) {
    const parsed = moveFromUci(move.uci);
    if (parsed) {
      shapes.push({ orig: parsed.to, brush: 'yellow' });
    }
    return {
      title: 'Checkmate',
      summary: `${move.san} delivers immediate checkmate.`,
      detail: 'A decisive conclusion to the game.',
      motif: 'mate',
      shapes,
    };
  }

  // 2. Missed Mate / Allowed Mate
  const hadMate =
    evalBeforeMate !== undefined &&
    evalBeforeMate !== null &&
    ((isWhite && evalBeforeMate > 0) || (!isWhite && evalBeforeMate < 0));
  const stillMate =
    evalAfterMate !== undefined &&
    evalAfterMate !== null &&
    ((isWhite && evalAfterMate > 0) || (!isWhite && evalAfterMate < 0));
  const opponentMate =
    evalAfterMate !== undefined &&
    evalAfterMate !== null &&
    ((isWhite && evalAfterMate < 0) || (!isWhite && evalAfterMate > 0));

  if (hadMate && !stillMate) {
    return {
      title: 'Missed mate',
      summary: `Forced mate was available with ${bestSan}.`,
      detail: `You played ${move.san} instead, allowing the opponent an escape window.`,
      motif: 'missed_mate',
      shapes,
    };
  }

  if (opponentMate) {
    const parsed = moveFromUci(move.uci);
    if (parsed) {
      shapes.push({ orig: parsed.to, brush: 'red' });
    }
    return {
      title: 'Allowed mate',
      summary: `${move.san} allows the opponent a forced checkmate sequence.`,
      detail: `The best defense was ${bestSan} to prevent the mating attack.`,
      motif: 'allowed_mate',
      shapes,
    };
  }

  // 3. Hanging / Under-defended Material
  const hanging = detectNewlyHangingPiece(beforeBoard, afterBoard, move.uci, move.color);
  if (hanging && (classification === 'inaccuracy' || classification === 'mistake' || classification === 'blunder')) {
    shapes.push({ orig: hanging.square, brush: 'red' });
    if (hanging.attackerSquare) {
      shapes.push({ orig: hanging.attackerSquare, dest: hanging.square, brush: 'red' });
    }
    return {
      title: 'Hanging piece',
      summary: `Your ${hanging.name} on ${hanging.square} is now under-defended and vulnerable.`,
      detail: `Played ${move.san} (loss: ~${lossText} pawns). The engine preferred ${bestSan} to maintain piece safety.`,
      motif: 'hanging_piece',
      motifDetail: { piece: hanging.name, square: hanging.square },
      shapes,
    };
  }

  // 4. Missed Fork (by engine best move) or Allowed Fork
  if (bestMove && (classification === 'inaccuracy' || classification === 'mistake' || classification === 'blunder')) {
    const testBoard = new Chess(beforeFen);
    try {
      testBoard.move(bestMove);
      const fork = detectFork(testBoard, bestMove.to, move.color);
      if (fork) {
        for (const t of fork.targets) {
          shapes.push({ orig: bestMove.to, dest: t.square, brush: 'yellow' });
        }
        const targetNames = fork.targets.map((t) => `the ${t.name} on ${t.square}`).join(' and ');
        return {
          title: 'Missed fork',
          summary: `The engine's move ${bestSan} forks ${targetNames}.`,
          detail: `${move.san} was played instead, letting both targets remain safe.`,
          motif: 'fork',
          motifDetail: { targets: fork.targets },
          shapes,
        };
      }
    } catch {
      // ignore
    }
  }

  // 5 & 6. Missed pin / missed skewer (by the engine's best move, not the
  // move actually played — same "simulate bestMove" pattern as the fork
  // check above. Checking the played move here would only ever describe
  // a pin/skewer created *against the opponent*, which is a good outcome
  // for the mover and can't explain a mistake/blunder row.)
  const playedMove = moveFromUci(move.uci);
  if (
    playedMove &&
    bestMove &&
    (classification === 'inaccuracy' || classification === 'mistake' || classification === 'blunder')
  ) {
    const lineTestBoard = new Chess(beforeFen);
    try {
      lineTestBoard.move(bestMove);
      const pin = detectLineMotif(lineTestBoard, bestMove.to, move.color);

      if (pin && pin.type === 'pin') {
        shapes.push({ orig: pin.attackerSquare, dest: pin.frontSquare, brush: 'yellow' });
        shapes.push({ orig: pin.frontSquare, dest: pin.behindSquare, brush: 'yellow' });
        return {
          title: 'Missed pin',
          summary: `The engine's move ${bestSan} pins the ${pin.frontPiece} on ${pin.frontSquare} to the ${pin.behindPiece} on ${pin.behindSquare}.`,
          detail: `${move.san} was played instead, letting the ${pin.frontPiece} move freely.`,
          motif: 'pin',
          motifDetail: { piece: pin.frontPiece, target: pin.behindPiece },
          shapes,
        };
      }

      if (pin && pin.type === 'skewer') {
        shapes.push({ orig: pin.attackerSquare, dest: pin.frontSquare, brush: 'yellow' });
        shapes.push({ orig: pin.frontSquare, dest: pin.behindSquare, brush: 'yellow' });
        return {
          title: 'Missed skewer',
          summary: `The engine's move ${bestSan} skewers the ${pin.frontPiece}, winning the ${pin.behindPiece} behind it.`,
          detail: `${move.san} was played instead, leaving both pieces safe.`,
          motif: 'skewer',
          motifDetail: { front: pin.frontPiece, behind: pin.behindPiece },
          shapes,
        };
      }
    } catch {
      // ignore — bestMove might not be legal to replay in edge cases
    }
  }

  if (playedMove) {
    // 7. Discovered Attack

    // 7. Discovered Attack
    const discovered = detectDiscoveredAttack(beforeBoard, afterBoard, playedMove, move.color === 'w' ? 'b' : 'w');
    if (discovered) {
      shapes.push({ orig: discovered.attackerSquare, dest: discovered.targetSquare, brush: 'red' });
      return {
        title: 'Discovered attack',
        summary: `A line has been opened against your ${discovered.targetPiece} on ${discovered.targetSquare}.`,
        detail: `The enemy slider gained direct sight of your piece after ${move.san}.`,
        motif: 'discovered_attack',
        motifDetail: { target: discovered.targetPiece, square: discovered.targetSquare },
        shapes,
      };
    }

    // 8. Back Rank Weakness
    const backRank = detectBackRank(afterBoard, move.color === 'w' ? 'b' : 'w');
    if (backRank) {
      shapes.push({ orig: backRank.kingSquare, brush: 'red' });
      return {
        title: 'Back-rank vulnerability',
        summary: `The king on ${backRank.kingSquare} has limited escape mobility on the back rank.`,
        detail: `A back-rank mate threat was created or intensified following ${move.san}.`,
        motif: 'back_rank',
        motifDetail: { kingSquare: backRank.kingSquare },
        shapes,
      };
    }
  }

  // 9. Positive classifications
  if (classification === 'best' || classification === 'excellent' || classification === 'good') {
    return {
      title: classification === 'best' ? 'Best move' : 'Solid continuation',
      summary: `${move.san} keeps the position balanced and active.`,
      detail: `The engine's top choice was ${bestSan}.`,
      motif: 'positive',
      shapes,
    };
  }

  // 10. General positional loss
  return {
    title: 'Evaluation shifted',
    summary: `No single tactical blunder detected; positional balance shifted by ~${lossText} pawns.`,
    detail: `The engine favored ${bestSan} to maintain optimal piece activity.`,
    motif: 'evaluation',
    shapes,
  };
}