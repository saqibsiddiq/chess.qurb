import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult, Classification } from './analysis';
import type { GameReview } from './reviewEngine';
import type { ParsedGame } from './parsePgn';
import { bookExitPly, openingFrom } from './openings';
import { terminationFrom } from './termination';

export interface ReviewSummary {
  id: string;
  savedAt: number;
  white: string;
  black: string;
  result: string;
  date: string;
  moveCount: number;
  whiteAccuracy: number;
  blackAccuracy: number;
  whiteCounts: Partial<Record<Classification, number>>;
  blackCounts: Partial<Record<Classification, number>>;
  whiteMotifs: Record<string, number>;
  blackMotifs: Record<string, number>;
  opening?: string | null;
  eco?: string | null;
  bookExitPly?: number | null;
  termination?: string | null;
}

export interface StoredReview {
  summary: ReviewSummary;
  pgn: string;
  analysis: AnalysisResult[];
  depth: number;
  multiPv: number;
}

export function reviewId(pgn: string): string {
  let hash = 2166136261;
  for (let i = 0; i < pgn.length; i++) {
    hash ^= pgn.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}-${pgn.length.toString(16)}`;
}

function tally(
  review: GameReview,
  color: 'w' | 'b',
): { counts: Record<string, number>; motifs: Record<string, number> } {
  const counts: Record<string, number> = {};
  const motifs: Record<string, number> = {};
  for (const move of review.moves) {
    if (move.color !== color) continue;
    counts[move.classification] = (counts[move.classification] ?? 0) + 1;
    const motif = move.explanation.motif;
    if (motif && motif !== 'positive' && motif !== 'evaluation' && motif !== 'none') {
      motifs[motif] = (motifs[motif] ?? 0) + 1;
    }
  }
  return { counts, motifs };
}

export function buildSummary(
  id: string,
  game: ParsedGame,
  review: GameReview,
): ReviewSummary {
  const white = tally(review, 'w');
  const black = tally(review, 'b');
  const opening = openingFrom(game.headers);
  return {
    opening: opening.name,
    eco: opening.eco,
    bookExitPly: bookExitPly(game),
    termination: terminationFrom(game.headers),
    id,
    savedAt: Date.now(),
    white: game.headers.White ?? 'Unknown',
    black: game.headers.Black ?? 'Unknown',
    result: game.headers.Result ?? '*',
    date: game.headers.Date ?? game.headers.UTCDate ?? '',
    moveCount: review.moves.length,
    whiteAccuracy: review.whiteAccuracy,
    blackAccuracy: review.blackAccuracy,
    whiteCounts: white.counts,
    blackCounts: black.counts,
    whiteMotifs: white.motifs,
    blackMotifs: black.motifs,
  };
}

export async function listReviews(): Promise<ReviewSummary[]> {
  return invoke<ReviewSummary[]>('list_reviews');
}

export async function loadReview(id: string): Promise<StoredReview> {
  return invoke<StoredReview>('load_review', { id });
}

export async function saveReview(review: StoredReview): Promise<void> {
  return invoke('save_review', { review });
}

export async function deleteReview(id: string): Promise<void> {
  return invoke('delete_review', { id });
}
