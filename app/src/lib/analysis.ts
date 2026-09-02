export interface AnalysisResult {
  bestMove: string;
  evalCp: number | null;
  evalMate: number | null;
  pv: string[];
  depth: number;
  // Second-best line from a MultiPV=2 search, used to detect "only good move"
  // (Great) and sacrifice (Brilliant) situations. Only populated when
  // analyze_game() runs in Deep mode; Fast mode (MultiPV=1) leaves these
  // null, which is why it can't produce Great/Brilliant classifications.
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

// Every review event carries the id of the run that emitted it. Listeners
// must drop events whose runId isn't the current run — see
// src-tauri/src/lib.rs's ReviewProgress for why (a stale run's events
// would otherwise be attributed to, and prematurely complete, the run
// that superseded it).
export interface ReviewProgressPayload {
  runId: number;
  index: number;
  total: number;
  result: AnalysisResult;
}

export interface ReviewCompletePayload {
  runId: number;
}

export interface ReviewErrorPayload {
  runId: number;
  message: string;
}
