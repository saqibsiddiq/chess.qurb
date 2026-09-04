export interface AnalysisResult {
  bestMove: string;
  evalCp: number | null;
  evalMate: number | null;
  pv: string[];
  depth: number;
  secondMove: string | null;
  secondEvalCp: number | null;
  secondEvalMate: number | null;
}

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
