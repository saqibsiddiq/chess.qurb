export interface AnalysisResult {
  bestMove: string;
  evalCp: number | null;
  evalMate: number | null;
  pv: string[];
  depth: number;
  // Second-best line from a MultiPV=2 search, used to detect "only good move"
  // (Great) and sacrifice (Brilliant) situations. Only populated by
  // analyze_game(); analyze_position()/check_engine() leave these null.
  secondMove: string | null;
  secondEvalCp: number | null;
  secondEvalMate: number | null;
}

// Chess.com's real 10-class scheme. Brilliant/Great/Book/Miss are Chesy
// approximations of a proprietary algorithm — see ml/specs/review_contract.md
// section 9.
export type Classification =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

export interface EngineInfo {
  available: boolean;
  name: string | null;
  path: string;
  error: string | null;
}

export interface ReviewProgressPayload {
  index: number;
  total: number;
  result: AnalysisResult;
}
