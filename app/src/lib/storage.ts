import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult, Classification } from './analysis';
import type { GameReview } from './reviewEngine';
import type { ParsedGame } from './parsePgn';

// Mirrors src-tauri/src/storage.rs. Only the engine output is persisted —
// classifications and explanation text are recomputed on load, which was
// measured at ~0.37ms per move (~30ms for a whole game). That keeps a
// single source of truth for the review logic and means improvements to
// the classifier apply retroactively to games reviewed long ago.
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
}

export interface StoredReview {
  summary: ReviewSummary;
  pgn: string;
  analysis: AnalysisResult[];
  depth: number;
  multiPv: number;
}

/// Content hash of the PGN, so importing the same game twice updates one
/// entry instead of accumulating duplicates. FNV-1a in hex — short,
/// stable, and (per storage.rs's validator) filesystem-safe by
/// construction.
export function reviewId(pgn: string): string {
  let hash = 2166136261;
  for (let i = 0; i < pgn.length; i++) {
    hash ^= pgn.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Mix in the length too: FNV alone collides more readily on inputs that
  // share long prefixes, which PGNs of the same opening very much do.
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
    // 'positive' and 'evaluation' aren't tactical motifs, just the
    // narrative labels for "nothing specific happened" — counting them
    // would swamp the genuinely interesting ones in a weakness report.
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
  return {
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
