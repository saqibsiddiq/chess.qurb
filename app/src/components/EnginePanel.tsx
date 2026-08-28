import { useMemo } from 'react';
import type { AnalysisResult } from '../lib/analysis.ts';
import type { Classification } from '../lib/reviewEngine.ts';
import type { MoveExplanation, TacticalMotif } from '../lib/explanations';
import { pvToSan, uciToSan } from '../lib/explanations';

interface EnginePanelProps {
  fen: string;
  analysis: AnalysisResult | null;
  classification?: Classification;
  explanation?: MoveExplanation;
  loading?: boolean;
  progressPercent?: number | null;
}

const MOTIF_LABELS: Partial<Record<TacticalMotif, string>> = {
  fork: 'Fork',
  pin: 'Pin',
  skewer: 'Skewer',
  discovered_attack: 'Discovered Attack',
  hanging_piece: 'Hanging Piece',
  missed_mate: 'Missed Mate',
  allowed_mate: 'Allowed Mate',
  back_rank: 'Back Rank Threat',
  mate: 'Checkmate',
};

function evalToPercent(evalCp: number | null, evalMate: number | null): number {
  if (evalMate !== null) return evalMate > 0 ? 100 : 0;
  if (evalCp === null) return 50;
  const capped = Math.max(-1000, Math.min(1000, evalCp));
  return 50 + (capped / 1000) * 50;
}

function formatEval(evalCp: number | null, evalMate: number | null): string {
  if (evalMate !== null) return `Mate in ${Math.abs(evalMate)}`;
  if (evalCp === null) return '—';
  const pawns = (evalCp / 100).toFixed(2);
  return evalCp > 0 ? `+${pawns}` : pawns;
}

export default function EnginePanel({
  fen,
  analysis,
  classification,
  explanation,
  loading = false,
  progressPercent = null,
}: EnginePanelProps) {
  const percent = evalToPercent(analysis?.evalCp ?? null, analysis?.evalMate ?? null);
  const motifLabel = explanation?.motif ? MOTIF_LABELS[explanation.motif] : undefined;

  const bestSan = useMemo(() => {
    return analysis && analysis.bestMove ? uciToSan(fen, analysis.bestMove) : '—';
  }, [fen, analysis?.bestMove]);

  const pvSan = useMemo(() => {
    return analysis && analysis.pv.length > 0 ? pvToSan(fen, analysis.pv.slice(0, 8)).join(' ') : '';
  }, [fen, analysis?.pv]);

  return (
    <div className="engine-panel">
      <div className="eval-bar">
        <div className="eval-bar-white" style={{ height: `${percent}%` }} />
      </div>
      <div className="engine-details">
        <div className="badge-row">
          {classification && (
            <div className={`classification-badge classification-${classification}`}>
              {classification.toUpperCase()}
            </div>
          )}
          {motifLabel && (
            <div className="motif-badge">
              {motifLabel.toUpperCase()}
            </div>
          )}
        </div>

        <div className="engine-eval">
          {loading && !analysis ? (
            <span className="eval-analyzing">
              Analyzing… {progressPercent !== null ? `(${progressPercent}%)` : ''}
            </span>
          ) : (
            formatEval(analysis?.evalCp ?? null, analysis?.evalMate ?? null)
          )}
        </div>

        {explanation && (
          <div className="move-explanation">
            <div className="explanation-kicker">
              <span>Why this move matters</span>
              {explanation.shapes.length > 0 && <span className="arrow-indicator">✦ Tactical overlays active</span>}
            </div>
            <div className="explanation-title">{explanation.title}</div>
            <p className="explanation-summary">{explanation.summary}</p>
            <p className="explanation-detail">{explanation.detail}</p>
          </div>
        )}

        <div className="engine-meta-row">
          <div className="engine-depth">Depth {analysis?.depth ?? '—'}</div>
          <div className="engine-best">Best: <strong>{bestSan}</strong></div>
        </div>
        {pvSan && (
          <div className="engine-pv" title={pvSan}>
            PV: {pvSan}
          </div>
        )}
      </div>
    </div>
  );
}
