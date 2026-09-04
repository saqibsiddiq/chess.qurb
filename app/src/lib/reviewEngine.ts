import { Chess } from 'chess.js';
import type { AnalysisResult, Classification } from './analysis';
import type { ParsedGame, ParsedMove } from './parsePgn';
import {
  detectMissedTactic,
  detectNewlyHangingPiece,
  explainMove,
  uciToSan,
  type MoveExplanation,
} from './explanations';
import { isBookMove } from './openingBook';
import { buildMoveFacts, type MoveFacts } from './slm';

export type { Classification };

export interface ReviewedMove extends ParsedMove {
  classification: Classification;
  lossCp: number;
  evalAfter: { cp: number | null; mate: number | null };
  bestMoveUci: string;
  explanation: MoveExplanation;
  slmFacts: MoveFacts;
}

export interface GameReview {
  moves: ReviewedMove[];
  whiteAccuracy: number;
  blackAccuracy: number;
}

const MATE_SCORE = 100_000;

const BOOK_LOSS_CEILING_CP = 100;
const GREAT_GAP_CP = 150;
const NONTRIVIAL_WP_LOW = 3;
const NONTRIVIAL_WP_HIGH = 97;
const BRILLIANT_MIN_SACRIFICE = 2;
const BRILLIANT_MIN_WP_AFTER = 60;

export function toCpValue(cp: number | null, mate: number | null, isWhiteTurn = true): number {
  if (mate !== null) {
    if (mate === 0) {
      return isWhiteTurn ? -MATE_SCORE : MATE_SCORE;
    }
    return mate > 0 ? MATE_SCORE - mate * 10 : -MATE_SCORE - mate * 10;
  }
  return cp ?? 0;
}

export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function moveAccuracy(winPercentBefore: number, winPercentAfter: number): number {
  const drop = Math.max(0, winPercentBefore - winPercentAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.min(100, Math.max(0, acc));
}

function isObviousRecapture(fenBefore: string, playedUci: string, prevMove: ParsedMove | undefined): boolean {
  if (!prevMove || !prevMove.san.includes('x')) return false;
  const toSquare = playedUci.slice(2, 4);
  if (prevMove.uci.slice(2, 4) !== toSquare) return false;
  try {
    const chess = new Chess(fenBefore);
    const captures = chess.moves({ verbose: true }).filter((m) => m.to === toSquare && m.captured);
    return captures.length === 1;
  } catch {
    return false;
  }
}

interface ClassifyInput {
  lossCp: number;
  playedUci: string;
  bestUci: string;
  wpBefore: number;
  wpAfter: number;
  isCheckmate: boolean;
  isBook: boolean;
  isObviousRecapture: boolean;
  gapCp: number | null;
  sacrificeValue: number | null;
  missedTacticMotif: 'missed_mate' | 'fork' | 'pin' | 'skewer' | null;
}

function classify(input: ClassifyInput): Classification {
  const {
    lossCp,
    playedUci,
    bestUci,
    wpBefore,
    wpAfter,
    isCheckmate,
    isBook,
    isObviousRecapture: obviousRecapture,
    gapCp,
    sacrificeValue,
    missedTacticMotif,
  } = input;

  if (isCheckmate) return 'best';

  if (missedTacticMotif === 'missed_mate') return 'miss';

  if (isBook && lossCp < BOOK_LOSS_CEILING_CP) return 'book';

  if (playedUci === bestUci) {
    const isNonTrivial = wpBefore > NONTRIVIAL_WP_LOW && wpBefore < NONTRIVIAL_WP_HIGH;
    const hasBigGap = gapCp !== null && gapCp >= GREAT_GAP_CP;
    if (isNonTrivial && hasBigGap && !obviousRecapture) {
      if (sacrificeValue !== null && sacrificeValue >= BRILLIANT_MIN_SACRIFICE && wpAfter >= BRILLIANT_MIN_WP_AFTER) {
        return 'brilliant';
      }
      return 'great';
    }
    return 'best';
  }

  const wpDrop = Math.max(0, wpBefore - wpAfter);

  if (wpBefore > 95 && wpAfter > 90) {
    if (lossCp < 50) return 'excellent';
    return 'good';
  }

  let severity: Classification;
  if (wpDrop < 5.0 && lossCp < 50) severity = 'excellent';
  else if (wpDrop < 10.0 && lossCp < 100) severity = 'good';
  else if (wpDrop < 18.0 && lossCp < 180) severity = 'inaccuracy';
  else if (wpDrop < 30.0 && lossCp < 320) severity = 'mistake';
  else severity = 'blunder';

  if (
    (severity === 'mistake' || severity === 'blunder') &&
    (missedTacticMotif === 'fork' || missedTacticMotif === 'pin' || missedTacticMotif === 'skewer')
  ) {
    return 'miss';
  }

  return severity;
}

export interface AccuracyAccumulator {
  whiteSum: number;
  whiteCount: number;
  blackSum: number;
  blackCount: number;
}

export const EMPTY_ACCURACY_ACCUMULATOR: AccuracyAccumulator = {
  whiteSum: 0,
  whiteCount: 0,
  blackSum: 0,
  blackCount: 0,
};

export function finalizeAccuracy(acc: AccuracyAccumulator): { whiteAccuracy: number; blackAccuracy: number } {
  return {
    whiteAccuracy: acc.whiteCount ? acc.whiteSum / acc.whiteCount : 100,
    blackAccuracy: acc.blackCount ? acc.blackSum / acc.blackCount : 100,
  };
}

export function reviewMove(
  game: ParsedGame,
  index: number,
  before: AnalysisResult,
  after: AnalysisResult,
  accumulator: AccuracyAccumulator,
): { reviewedMove: ReviewedMove; accumulator: AccuracyAccumulator } {
  const move = game.moves[index];
  const i = index;
  const fenBefore = i === 0 ? game.startingFen : game.moves[i - 1].fenAfter;

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

  const nextAccumulator: AccuracyAccumulator =
    move.color === 'w'
      ? { ...accumulator, whiteSum: accumulator.whiteSum + accuracy, whiteCount: accumulator.whiteCount + 1 }
      : { ...accumulator, blackSum: accumulator.blackSum + accuracy, blackCount: accumulator.blackCount + 1 };

  const hasSecondLine = before.secondEvalCp !== null || before.secondEvalMate !== null;
  const gapCp = hasSecondLine
    ? Math.abs(cpBefore - toCpValue(before.secondEvalCp, before.secondEvalMate, move.color === 'w'))
    : null;

  const missedTactic = detectMissedTactic(move, fenBefore, before, before.evalMate, isCheckmate ? 0 : after.evalMate);

  let sacrificeValue: number | null = null;
  if (!isCheckmate && move.uci === before.bestMove) {
    const beforeBoard = new Chess(fenBefore);
    const afterBoard = new Chess(move.fenAfter);
    const hanging = detectNewlyHangingPiece(beforeBoard, afterBoard, move.uci, move.color);
    sacrificeValue = hanging ? hanging.value : null;
  }

  const classification = classify({
    lossCp,
    playedUci: move.uci,
    bestUci: before.bestMove,
    wpBefore,
    wpAfter,
    isCheckmate,
    isBook: isBookMove(fenBefore, move.uci),
    isObviousRecapture: isObviousRecapture(fenBefore, move.uci, i === 0 ? undefined : game.moves[i - 1]),
    gapCp,
    sacrificeValue,
    missedTacticMotif: missedTactic?.motif ?? null,
  });

  const explanation = explainMove(
    move,
    fenBefore,
    before,
    lossCp,
    classification,
    isCheckmate ? 0 : after.evalMate,
    missedTactic,
  );
  const evalAfter = isCheckmate
    ? { cp: null, mate: move.color === 'w' ? 1 : -1 }
    : { cp: after.evalCp, mate: after.evalMate };

  const reviewedMove: ReviewedMove = {
    ...move,
    classification,
    lossCp,
    evalAfter,
    bestMoveUci: before.bestMove,
    explanation,
    slmFacts: buildMoveFacts(
      move,
      fenBefore,
      before,
      uciToSan(fenBefore, before.bestMove),
      lossCp,
      classification,
      evalAfter.cp,
      evalAfter.mate,
      explanation,
    ),
  };

  return { reviewedMove, accumulator: nextAccumulator };
}

export function reviewGame(game: ParsedGame, analysis: AnalysisResult[]): GameReview {
  const moves: ReviewedMove[] = [];
  let accumulator = EMPTY_ACCURACY_ACCUMULATOR;

  for (let i = 0; i < game.moves.length; i++) {
    const result = reviewMove(game, i, analysis[i], analysis[i + 1], accumulator);
    moves.push(result.reviewedMove);
    accumulator = result.accumulator;
  }

  return { moves, ...finalizeAccuracy(accumulator) };
}
