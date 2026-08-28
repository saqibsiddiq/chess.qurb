import { Chess } from 'chess.js';
import type { AnalysisResult } from './analysis';
import type { ParsedGame, ParsedMove } from './parsePgn';
import { explainMove, type MoveExplanation } from './explanations';

export type Classification =
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface ReviewedMove extends ParsedMove {
  classification: Classification;
  lossCp: number;
  evalAfter: { cp: number | null; mate: number | null };
  bestMoveUci: string;
  explanation: MoveExplanation;
}

export interface GameReview {
  moves: ReviewedMove[];
  whiteAccuracy: number;
  blackAccuracy: number;
}

const MATE_SCORE = 100_000;

function toCpValue(cp: number | null, mate: number | null, isWhiteTurn = true): number {
  if (mate !== null) {
    if (mate === 0) {
      // Terminal checkmate: if it's black's turn and black is mated, White won (+MATE_SCORE)
      return isWhiteTurn ? -MATE_SCORE : MATE_SCORE;
    }
    return mate > 0 ? MATE_SCORE - mate * 10 : -MATE_SCORE - mate * 10;
  }
  return cp ?? 0;
}

// Lichess win% formula converting White-relative centipawns to White win probability
function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function moveAccuracy(winPercentBefore: number, winPercentAfter: number): number {
  const drop = Math.max(0, winPercentBefore - winPercentAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.min(100, Math.max(0, acc));
}

function classify(
  lossCp: number,
  playedUci: string,
  bestUci: string,
  wpBefore: number,
  wpAfter: number,
  isCheckmate: boolean,
): Classification {
  if (isCheckmate || playedUci === bestUci || lossCp < 5) return 'best';
  const wpDrop = Math.max(0, wpBefore - wpAfter);

  // If mover is overwhelmingly winning (>95%) and stays winning (>90%), don't label as blunder
  if (wpBefore > 95 && wpAfter > 90) {
    if (lossCp < 50) return 'excellent';
    return 'good';
  }

  if (wpDrop < 2.5 && lossCp < 25) return 'best';
  if (wpDrop < 5.0 && lossCp < 50) return 'excellent';
  if (wpDrop < 10.0 && lossCp < 100) return 'good';
  if (wpDrop < 18.0 && lossCp < 180) return 'inaccuracy';
  if (wpDrop < 30.0 && lossCp < 320) return 'mistake';
  return 'blunder';
}

export function reviewGame(game: ParsedGame, analysis: AnalysisResult[]): GameReview {
  const moves: ReviewedMove[] = [];
  let whiteAccSum = 0;
  let whiteAccCount = 0;
  let blackAccSum = 0;
  let blackAccCount = 0;

  for (let i = 0; i < game.moves.length; i++) {
    const move = game.moves[i];
    const before = analysis[i];
    const after = analysis[i + 1];

    let isCheckmate = false;
    try {
      isCheckmate = new Chess(move.fenAfter).isCheckmate();
    } catch {
      isCheckmate = false;
    }

    const nextTurnIsWhite = move.color === 'b';
    const cpBefore = toCpValue(before.evalCp, before.evalMate, move.color === 'w');
    const cpAfter = isCheckmate
      ? move.color === 'w'
        ? MATE_SCORE
        : -MATE_SCORE
      : toCpValue(after.evalCp, after.evalMate, nextTurnIsWhite);

    const rawDelta = move.color === 'w' ? cpBefore - cpAfter : cpAfter - cpBefore;
    const lossCp = isCheckmate ? 0 : Math.max(0, rawDelta);

    const wpBefore = move.color === 'w' ? winPercent(cpBefore) : 100 - winPercent(cpBefore);
    const wpAfter = isCheckmate
      ? 100
      : move.color === 'w'
        ? winPercent(cpAfter)
        : 100 - winPercent(cpAfter);

    const accuracy = isCheckmate ? 100 : moveAccuracy(wpBefore, wpAfter);

    if (move.color === 'w') {
      whiteAccSum += accuracy;
      whiteAccCount += 1;
    } else {
      blackAccSum += accuracy;
      blackAccCount += 1;
    }

    const classification = classify(lossCp, move.uci, before.bestMove, wpBefore, wpAfter, isCheckmate);

    moves.push({
      ...move,
      classification,
      lossCp,
      evalAfter: isCheckmate
        ? { cp: null, mate: move.color === 'w' ? 1 : -1 }
        : { cp: after.evalCp, mate: after.evalMate },
      bestMoveUci: before.bestMove,
      explanation: explainMove(
        move,
        i === 0 ? game.startingFen : game.moves[i - 1].fenAfter,
        before,
        lossCp,
        classification,
        before.evalMate,
        isCheckmate ? 0 : after.evalMate,
      ),
    });
  }

  return {
    moves,
    whiteAccuracy: whiteAccCount ? whiteAccSum / whiteAccCount : 100,
    blackAccuracy: blackAccCount ? blackAccSum / blackAccCount : 100,
  };
}
