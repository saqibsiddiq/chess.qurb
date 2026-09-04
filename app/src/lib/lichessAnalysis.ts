import type { AnalysisResult } from './analysis';
import type { ParsedGame } from './parsePgn';

export interface LichessAnalysisEntry {
  eval?: number;
  mate?: number;
  best?: string;
  variation?: string;
  judgment?: { name: string; comment: string };
}

export function toAnalysisResults(
  analysis: LichessAnalysisEntry[],
  game: ParsedGame,
): AnalysisResult[] {
  const positions = game.moves.length + 1;
  const results: AnalysisResult[] = [];

  for (let k = 0; k < positions; k++) {
    const after = k === 0 ? undefined : analysis[k - 1];
    const from = analysis[k];

    const playedNext = game.moves[k]?.uci;
    const bestMove = from?.best ?? playedNext ?? '';

    results.push({
      evalCp: k === 0 ? 0 : after?.mate !== undefined ? null : after?.eval ?? 0,
      evalMate: k === 0 ? null : after?.mate ?? null,
      bestMove,
      pv: [],
      secondMove: null,
      secondEvalCp: null,
      secondEvalMate: null,
      depth: 0,
    });
  }

  return results;
}

export function hasUsableAnalysis(
  analysis: LichessAnalysisEntry[] | undefined,
  game: ParsedGame,
): boolean {
  return !!analysis && analysis.length >= game.moves.length && game.moves.length > 0;
}
