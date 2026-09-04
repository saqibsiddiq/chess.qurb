import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { AnalysisResult, Classification } from './analysis';
import type { ParsedMove } from './parsePgn';
import {
  allowedMateDetails,
  allowedMateSummaries,
  backRankConsequences,
  backRankDetails,
  backRankOpeners,
  bestDetails,
  bestSummaries,
  bookDetails,
  bookSummaries,
  brilliantDetails,
  brilliantSummaries,
  checkmateDetails,
  checkmateSummaries,
  discoveredConsequences,
  discoveredDetails,
  discoveredOpeners,
  fallbackDetails,
  fallbackSummaries,
  forkConsequences,
  forkDetails,
  forkOpeners,
  greatDetails,
  greatSummaries,
  hangingConsequences,
  hangingDetails,
  hangingOpeners,
  hangingSummariesNoAttacker,
  missedMateDetails,
  missedMateSummaries,
  pickVariant,
  pinConsequences,
  pinDetails,
  pinOpeners,
  skewerConsequences,
  skewerDetails,
  skewerOpeners,
  solidDetails,
  solidSummaries,
} from './explanationVariants';

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

// Exported so practice mode names the attacking piece with the same
// vocabulary the review uses.
export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

// Standard pawn-unit values, used for sacrifice detection (Brilliant).
export const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
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

// Uniquely (and stably) identifies one ply, for seeding pickVariant() —
// the same move always gets the same phrasing on repeat views; only
// different moves land on different wording.
function moveSeed(move: ParsedMove, tag: string): string {
  return `${move.color}${move.moveNumber}:${move.uci}:${tag}`;
}

// Joins two independently-picked, independently-complete sentences into
// one summary — see explanationVariants.ts for why composing two small
// pools this way covers far more combinations than one large flat pool.
function compose(opener: string, consequence: string): string {
  return `${opener} ${consequence}`;
}

// Plain-language framing for the generic positional-loss case, so the
// headline sentence reads like a coach talking, not a data readout — the
// precise pawn figure is still shown, just as supporting detail rather
// than the main point.
function severityWord(classification: Classification): string {
  switch (classification) {
    case 'mistake':
      return 'a real mistake';
    case 'blunder':
      return 'a costly blunder';
    case 'miss':
      return 'a missed opportunity';
    default:
      return 'a small slip';
  }
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
    // used by this dataset's motif vocabulary. A king can't itself be
    // pinned (it's forced to move out of any attack regardless), so a
    // king-in-front case is excluded here and left to the skewer check
    // below — otherwise a real skewer through the king would get
    // misclassified as a pin whenever the piece behind is q/r/k too.
    if (frontResult.piece.type !== 'k' && ['k', 'q', 'r'].includes(behindResult.piece.type)) {
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

export function detectNewlyHangingPiece(
  before: Chess,
  after: Chess,
  playedUci: string,
  color: Color,
): { square: Square; name: string; value: number; attackerSquare?: Square } | null {
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
        value: PIECE_VALUES[piece.type],
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

export interface MissedTacticResult {
  motif: 'missed_mate' | 'fork' | 'pin' | 'skewer';
  title: string;
  summary: string;
  detail: string;
  motifDetail?: Record<string, unknown>;
  shapes: BoardShape[];
}

/**
 * Facts about a tactical opportunity the played move let slip: a forced
 * mate, or a fork/pin/skewer available via the engine's best move. Computed
 * independently of classification (unlike the rest of this file) so
 * reviewEngine.ts's classify() can consult it when deciding Miss — see
 * ml/specs/review_contract.md section 9 (Chesy approximation).
 */
export function detectMissedTactic(
  move: ParsedMove,
  beforeFen: string,
  analysisBefore: AnalysisResult,
  evalBeforeMate?: number | null,
  evalAfterMate?: number | null,
): MissedTacticResult | null {
  const isWhite = move.color === 'w';
  const bestSan = uciToSan(beforeFen, analysisBefore.bestMove);

  const hadMate =
    evalBeforeMate !== undefined &&
    evalBeforeMate !== null &&
    ((isWhite && evalBeforeMate > 0) || (!isWhite && evalBeforeMate < 0));
  const stillMate =
    evalAfterMate !== undefined &&
    evalAfterMate !== null &&
    ((isWhite && evalAfterMate > 0) || (!isWhite && evalAfterMate < 0));

  if (hadMate && !stillMate) {
    return {
      motif: 'missed_mate',
      title: 'Missed mate',
      summary: pickVariant(moveSeed(move, 'missed_mate:summary'), missedMateSummaries)(bestSan),
      detail: pickVariant(moveSeed(move, 'missed_mate:detail'), missedMateDetails)(move.san),
      shapes: [],
    };
  }

  const bestMove = moveFromUci(analysisBefore.bestMove);
  if (!bestMove || analysisBefore.bestMove === move.uci) return null;

  const testBoard = new Chess(beforeFen);
  try {
    testBoard.move(bestMove);

    const fork = detectFork(testBoard, bestMove.to, move.color);
    if (fork) {
      const targetNames = fork.targets.map((t) => `the ${t.name} on ${t.square}`).join(' and ');
      return {
        motif: 'fork',
        title: 'Missed fork',
        summary: compose(
          pickVariant(moveSeed(move, 'fork:opener'), forkOpeners)({ bestSan, targetNames }),
          pickVariant(moveSeed(move, 'fork:consequence'), forkConsequences),
        ),
        detail: pickVariant(moveSeed(move, 'fork:detail'), forkDetails)(move.san),
        motifDetail: { targets: fork.targets },
        shapes: fork.targets.map((t) => ({ orig: bestMove.to, dest: t.square, brush: 'yellow' as const })),
      };
    }

    const pin = detectLineMotif(testBoard, bestMove.to, move.color);
    if (pin && pin.type === 'pin') {
      return {
        motif: 'pin',
        title: 'Missed pin',
        summary: compose(
          pickVariant(moveSeed(move, 'pin:opener'), pinOpeners)({ bestSan, frontPiece: pin.frontPiece }),
          pickVariant(moveSeed(move, 'pin:consequence'), pinConsequences)(pin.behindPiece),
        ),
        detail: pickVariant(moveSeed(move, 'pin:detail'), pinDetails)({ san: move.san, frontPiece: pin.frontPiece }),
        motifDetail: { piece: pin.frontPiece, target: pin.behindPiece },
        shapes: [
          { orig: pin.attackerSquare, dest: pin.frontSquare, brush: 'yellow' },
          { orig: pin.frontSquare, dest: pin.behindSquare, brush: 'yellow' },
        ],
      };
    }
    if (pin && pin.type === 'skewer') {
      return {
        motif: 'skewer',
        title: 'Missed skewer',
        summary: compose(
          pickVariant(moveSeed(move, 'skewer:opener'), skewerOpeners)({
            bestSan,
            frontPiece: pin.frontPiece,
            behindPiece: pin.behindPiece,
          }),
          pickVariant(moveSeed(move, 'skewer:consequence'), skewerConsequences)(pin.behindPiece),
        ),
        detail: pickVariant(moveSeed(move, 'skewer:detail'), skewerDetails)(move.san),
        motifDetail: { front: pin.frontPiece, behind: pin.behindPiece },
        shapes: [
          { orig: pin.attackerSquare, dest: pin.frontSquare, brush: 'yellow' },
          { orig: pin.frontSquare, dest: pin.behindSquare, brush: 'yellow' },
        ],
      };
    }
  } catch {
    // bestMove might not be legal to replay in edge cases
  }

  return null;
}

/**
 * What the side to move is threatening in a position.
 *
 * Explanations otherwise only describe what the player's own move did.
 * Just as instructive is what is now coming *at* them — and the detectors
 * already take a colour, so this is the same machinery pointed the other
 * way rather than a second implementation.
 */
export function describeThreat(fenAfter: string): string | null {
  let board: Chess;
  try {
    board = new Chess(fenAfter);
  } catch {
    return null;
  }

  // Whoever is to move is the one with the threat.
  const attacker = board.turn();
  const defender: Color = attacker === 'w' ? 'b' : 'w';

  // A piece the defender has left hanging is the most concrete threat
  // there is: it can simply be taken.
  const loose = board
    .board()
    .flat()
    .filter((sq): sq is NonNullable<typeof sq> => sq !== null)
    .filter((sq) => sq.color === defender && sq.type !== 'k')
    .find(
      (sq) =>
        board.attackers(sq.square, attacker).length > 0 &&
        board.attackers(sq.square, defender).length === 0,
    );
  if (loose) {
    return `Your ${PIECE_NAMES[loose.type]} on ${loose.square} is undefended and can be taken.`;
  }

  const backRank = detectBackRank(board, defender);
  if (backRank) {
    return `Your king on ${backRank.kingSquare} is short of escape squares, so watch the back rank.`;
  }

  return null;
}

export function explainMove(
  move: ParsedMove,
  beforeFen: string,
  analysisBefore: AnalysisResult,
  lossCp: number,
  classification: Classification,
  evalAfterMate?: number | null,
  missedTactic?: MissedTacticResult | null,
): MoveExplanation {
  const bestSan = uciToSan(beforeFen, analysisBefore.bestMove);
  const lossText = formatLoss(lossCp);
  const beforeBoard = new Chess(beforeFen);
  const afterBoard = new Chess(move.fenAfter);
  const isWhite = move.color === 'w';
  const bestMove = moveFromUci(analysisBefore.bestMove);

  // Every branch below builds its own complete, intentional shape set —
  // nothing is pre-accumulated here. A shared "always show the engine's
  // best move" base used to get combined with branch-specific arrows
  // (e.g. a missed fork's yellow arrows plus a redundant green one from
  // essentially the same square), which is what actually made arrows
  // look cluttered/confusing rather than any square being invalid.
  const bestMoveArrow: BoardShape[] = bestMove ? [{ orig: bestMove.from, dest: bestMove.to, brush: 'green' }] : [];

  /** The move actually played, drawn only where it differs from the best
   *  one. Two arrows in different colours answer "what did I do" and
   *  "what should I have done" at a glance, which one arrow cannot. */
  const playedArrow: BoardShape[] = (() => {
    if (move.uci === analysisBefore.bestMove) return [];
    const played = moveFromUci(move.uci);
    return played ? [{ orig: played.from, dest: played.to, brush: 'blue' as const }] : [];
  })();

  // 1. Immediate Checkmate Played
  if (afterBoard.isCheckmate()) {
    const parsed = moveFromUci(move.uci);
    return {
      title: 'Checkmate',
      summary: pickVariant(moveSeed(move, 'mate:summary'), checkmateSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'mate:detail'), checkmateDetails),
      motif: 'mate',
      shapes: parsed ? [{ orig: parsed.to, brush: 'yellow' }] : [],
    };
  }

  // 2. Missed Mate / Allowed Mate
  const opponentMate =
    evalAfterMate !== undefined &&
    evalAfterMate !== null &&
    ((isWhite && evalAfterMate < 0) || (!isWhite && evalAfterMate > 0));

  if (missedTactic?.motif === 'missed_mate') {
    return {
      title: missedTactic.title,
      summary: missedTactic.summary,
      detail: missedTactic.detail,
      motif: 'missed_mate',
      // The one thing worth pointing at is the mating move itself.
      shapes: bestMoveArrow,
    };
  }

  if (opponentMate) {
    const parsed = moveFromUci(move.uci);
    return {
      title: 'Allowed mate',
      summary: pickVariant(moveSeed(move, 'allowed_mate:summary'), allowedMateSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'allowed_mate:detail'), allowedMateDetails)(bestSan),
      motif: 'allowed_mate',
      // Where the danger came from, plus the defense that avoided it.
      shapes: [...(parsed ? [{ orig: parsed.to, brush: 'red' as const }] : []), ...bestMoveArrow],
    };
  }

  // 3. Hanging / Under-defended Material
  const hanging = detectNewlyHangingPiece(beforeBoard, afterBoard, move.uci, move.color);
  if (
    hanging &&
    (classification === 'inaccuracy' ||
      classification === 'mistake' ||
      classification === 'blunder' ||
      classification === 'miss')
  ) {
    const hangingShapes: BoardShape[] = [{ orig: hanging.square, brush: 'red' }];
    if (hanging.attackerSquare) {
      hangingShapes.push({ orig: hanging.attackerSquare, dest: hanging.square, brush: 'red' });
    }
    // Naming the actual attacker (not just "vulnerable") is the concrete,
    // checkable reason a piece is hanging — a player can go verify it on
    // the board immediately, rather than taking the label on faith.
    const attackerPiece = hanging.attackerSquare ? afterBoard.get(hanging.attackerSquare) : null;
    const attackerName = attackerPiece ? PIECE_NAMES[attackerPiece.type] : null;
    return {
      title: 'Hanging piece',
      summary:
        attackerName && hanging.attackerSquare
          ? compose(
              pickVariant(moveSeed(move, 'hanging:opener'), hangingOpeners)({
                pieceName: hanging.name,
                square: hanging.square,
              }),
              pickVariant(moveSeed(move, 'hanging:consequence'), hangingConsequences)({
                attackerName,
                attackerSquare: hanging.attackerSquare,
              }),
            )
          : pickVariant(moveSeed(move, 'hanging:summary'), hangingSummariesNoAttacker)({
              pieceName: hanging.name,
              square: hanging.square,
            }),
      detail: pickVariant(moveSeed(move, 'hanging:detail'), hangingDetails)({ bestSan, lossText }),
      motif: 'hanging_piece',
      motifDetail: { piece: hanging.name, square: hanging.square },
      // What's hanging and to whom, plus what avoids it — two arrows
      // with clearly different colors/meanings, not redundant.
      shapes: [...hangingShapes, ...bestMoveArrow],
    };
  }

  // 4, 5 & 6. Missed fork / pin / skewer (by the engine's best move, not the
  // move actually played) — facts already computed by detectMissedTactic()
  // in reviewEngine.ts's classify() pass, reused here for narration instead
  // of re-simulating the best move.
  const tacticGateOpen =
    classification === 'inaccuracy' ||
    classification === 'mistake' ||
    classification === 'blunder' ||
    classification === 'miss';
  if (
    tacticGateOpen &&
    missedTactic &&
    (missedTactic.motif === 'fork' || missedTactic.motif === 'pin' || missedTactic.motif === 'skewer')
  ) {
    return {
      title: missedTactic.title,
      summary: missedTactic.summary,
      detail: missedTactic.detail,
      motif: missedTactic.motif,
      motifDetail: missedTactic.motifDetail,
      // The green arrow is not redundant here, which an earlier pass
      // assumed when it removed it. The tactic's yellow arrows fan out
      // from `bestMove.to` — a square that is *empty in the position on
      // screen*, because the best move has not been played. Drawing the
      // move that gets a piece there is what makes the rest legible:
      // green says "play this", yellow says "and it hits these".
      shapes: [...bestMoveArrow, ...missedTactic.shapes],
    };
  }

  const playedMove = moveFromUci(move.uci);
  if (playedMove) {
    // 7. Discovered Attack
    const discovered = detectDiscoveredAttack(beforeBoard, afterBoard, playedMove, move.color === 'w' ? 'b' : 'w');
    if (discovered) {
      // Naming the actual attacking piece (bishop/rook/queen) instead of a
      // generic "slider" label — a player can look at the board and see
      // exactly which piece is doing the attacking.
      const attackerPiece = afterBoard.get(discovered.attackerSquare);
      const attackerName = attackerPiece ? PIECE_NAMES[attackerPiece.type] : 'piece';
      return {
        title: 'Discovered attack',
        summary: compose(
          pickVariant(moveSeed(move, 'discovered:opener'), discoveredOpeners)(move.san),
          pickVariant(moveSeed(move, 'discovered:consequence'), discoveredConsequences)({
            attackerName,
            attackerSquare: discovered.attackerSquare,
            targetPiece: discovered.targetPiece,
            targetSquare: discovered.targetSquare,
          }),
        ),
        detail: pickVariant(moveSeed(move, 'discovered:detail'), discoveredDetails),
        motif: 'discovered_attack',
        motifDetail: { target: discovered.targetPiece, square: discovered.targetSquare },
        shapes: [{ orig: discovered.attackerSquare, dest: discovered.targetSquare, brush: 'red' }],
      };
    }

    // 8. Back Rank Weakness
    const backRank = detectBackRank(afterBoard, move.color === 'w' ? 'b' : 'w');
    if (backRank) {
      return {
        title: 'Back-rank vulnerability',
        summary: compose(
          pickVariant(moveSeed(move, 'back_rank:opener'), backRankOpeners)(backRank.kingSquare),
          pickVariant(moveSeed(move, 'back_rank:consequence'), backRankConsequences),
        ),
        detail: pickVariant(moveSeed(move, 'back_rank:detail'), backRankDetails)(move.san),
        motif: 'back_rank',
        motifDetail: { kingSquare: backRank.kingSquare },
        shapes: [{ orig: backRank.kingSquare, brush: 'red' }],
      };
    }
  }

  // 9. Positive classifications — only point at the engine's move when it
  // differs from what was actually played; if they're the same move,
  // there's nothing to point to.
  const positiveShapes = move.uci === analysisBefore.bestMove ? [] : bestMoveArrow;

  if (classification === 'brilliant') {
    return {
      title: 'Brilliant!!',
      summary: pickVariant(moveSeed(move, 'brilliant:summary'), brilliantSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'brilliant:detail'), brilliantDetails),
      motif: 'positive',
      shapes: positiveShapes,
    };
  }
  if (classification === 'great') {
    return {
      title: 'Great move!',
      summary: pickVariant(moveSeed(move, 'great:summary'), greatSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'great:detail'), greatDetails),
      motif: 'positive',
      shapes: positiveShapes,
    };
  }
  if (classification === 'book') {
    return {
      title: 'Book move',
      summary: pickVariant(moveSeed(move, 'book:summary'), bookSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'book:detail'), bookDetails),
      motif: 'positive',
      shapes: positiveShapes,
    };
  }
  if (classification === 'best') {
    return {
      title: 'Best move',
      summary: pickVariant(moveSeed(move, 'best:summary'), bestSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'best:detail'), bestDetails),
      motif: 'positive',
      shapes: positiveShapes,
    };
  }
  if (classification === 'excellent' || classification === 'good') {
    return {
      title: 'Solid continuation',
      summary: pickVariant(moveSeed(move, 'solid:summary'), solidSummaries)(move.san),
      detail: pickVariant(moveSeed(move, 'solid:detail'), solidDetails)({ san: move.san, bestSan }),
      motif: 'positive',
      shapes: positiveShapes,
    };
  }

  // 10. General positional loss
  return {
    title: 'Evaluation shifted',
    summary: pickVariant(moveSeed(move, 'fallback:summary'), fallbackSummaries)({
      san: move.san,
      severity: severityWord(classification),
    }),
    detail: pickVariant(moveSeed(move, 'fallback:detail'), fallbackDetails)({ bestSan, lossText }),
    motif: 'evaluation',
    shapes: [...playedArrow, ...bestMoveArrow],
  };
}