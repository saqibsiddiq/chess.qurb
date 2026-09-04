import type { AnalysisResult } from './analysis';
import type { ParsedGame } from './parsePgn';

// Lichess hands back a full per-ply analysis for any game that has been
// analysed on their servers. Chesy previously threw it away and spent
// minutes of local Stockfish re-deriving the same numbers — on a phone
// that is the single most expensive thing the app does. Reusing it gives
// a complete evaluation graph and mistake list for the cost of the
// download that already happened.

/** One entry of Lichess's `analysis` array — one per ply. */
export interface LichessAnalysisEntry {
  /** Centipawns, from White's point of view, *after* this ply. */
  eval?: number;
  /** Forced mate distance, from White's point of view, after this ply. */
  mate?: number;
  /** UCI of the move that should have been played *instead* of this ply.
   *  Only present when Lichess judged the ply an error. */
  best?: string;
  variation?: string;
  judgment?: { name: string; comment: string };
}

/**
 * Converts Lichess's per-ply analysis into the `AnalysisResult[]` the
 * review engine consumes.
 *
 * The two formats are indexed differently, which is the whole difficulty:
 *
 * - Lichess `analysis[i]` mixes two frames of reference. Its `eval` is the
 *   evaluation *after* ply `i`, while its `best` names the move that
 *   should have been played *instead of* ply `i` — a fact about the
 *   position *before* it.
 * - Chesy indexes by position: entry `k` describes the position reached
 *   after `k` plies, and its `bestMove` is the best continuation *from*
 *   that position.
 *
 * So position `k` takes its evaluation from `analysis[k - 1]` and its best
 * move from `analysis[k]`.
 */
export function toAnalysisResults(
  analysis: LichessAnalysisEntry[],
  game: ParsedGame,
): AnalysisResult[] {
  const positions = game.moves.length + 1;
  const results: AnalysisResult[] = [];

  for (let k = 0; k < positions; k++) {
    const after = k === 0 ? undefined : analysis[k - 1];
    const from = analysis[k];

    // `best` only appears on plies Lichess actually faulted. Its absence
    // is itself information: the move played was not judged an error, so
    // treating it as the best move is the correct reading — and it keeps
    // the classifier's `played === best` comparison meaningful instead of
    // marking every unremarkable move as a deviation.
    const playedNext = game.moves[k]?.uci;
    const bestMove = from?.best ?? playedNext ?? '';

    results.push({
      // The opening position has no preceding ply to be evaluated, and
      // Lichess sends no pre-game evaluation, so it is taken as level.
      evalCp: k === 0 ? 0 : after?.mate !== undefined ? null : after?.eval ?? 0,
      evalMate: k === 0 ? null : after?.mate ?? null,
      bestMove,
      pv: [],
      // Lichess reports a single line, so there is no runner-up to
      // compare against. Great and Brilliant need that second line, so
      // they simply won't be detected here — the same trade the app's own
      // Fast mode already makes, not a defect.
      secondMove: null,
      secondEvalCp: null,
      secondEvalMate: null,
      depth: 0,
    });
  }

  return results;
}

/**
 * Whether a game's analysis is complete enough to review from.
 *
 * A partially-analysed game would produce a graph with holes in it that
 * looked like real evaluations, so anything short of one entry per ply is
 * rejected and the local engine runs instead.
 */
export function hasUsableAnalysis(
  analysis: LichessAnalysisEntry[] | undefined,
  game: ParsedGame,
): boolean {
  return !!analysis && analysis.length >= game.moves.length && game.moves.length > 0;
}
