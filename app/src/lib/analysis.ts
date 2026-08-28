export interface AnalysisResult {
  bestMove: string;
  evalCp: number | null;
  evalMate: number | null;
  pv: string[];
  depth: number;
}

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
