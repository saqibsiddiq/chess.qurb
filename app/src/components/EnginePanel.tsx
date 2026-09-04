import { memo, useEffect, useMemo, useState } from 'react';
import type { AnalysisResult } from '../lib/analysis.ts';
import { toCpValue, winPercent, type Classification } from '../lib/reviewEngine.ts';
import type { MoveExplanation, TacticalMotif } from '../lib/explanations';
import { describeThreat, pvToSan, uciToSan } from '../lib/explanations';
import type { SlmState } from '../lib/slm.ts';
import { IconChevronRight } from './icons';
import { useT } from '../lib/i18n';
import { VERDICT_COPY, type PracticeAttempt } from '../lib/practice';

/** The live drill, when one is running. */
export interface PracticeView {
  attempts: PracticeAttempt[];
  status: 'awaiting' | 'judging' | 'revealed';
  error?: string;
}

interface EnginePanelProps {
  fen: string;
  analysis: AnalysisResult | null;
  classification?: Classification;
  explanation?: MoveExplanation;
  slmState?: SlmState;
  // Present only when a deep dive can be requested for the current move
  // (i.e. review has classified it); undefined hides the button entirely
  // rather than showing a disabled one.
  onRequestDeepDive?: () => void;
  loading?: boolean;
  progressPercent?: number | null;
  /* Practice lives inside this card rather than below it. Appending a
     block pushed the explanation, the engine lines and the move list
     down the moment the button appeared; swapping the card's body keeps
     the layout still whether a drill is running or not. */
  practice?: PracticeView | null;
  canPractice?: boolean;
  practiceBestSan?: string;
  onStartPractice?: () => void;
  onRevealPractice?: () => void;
  onExitPractice?: () => void;
}

const MOTIF_LABELS: Partial<Record<TacticalMotif, string>> = {
  fork: 'Fork',
  pin: 'Pin',
  skewer: 'Skewer',
  discovered_attack: 'Discovered attack',
  hanging_piece: 'Hanging piece',
  missed_mate: 'Missed mate',
  allowed_mate: 'Allowed mate',
  back_rank: 'Back rank threat',
  mate: 'Checkmate',
};

const CLASSIFICATION_LABELS: Record<Classification, string> = {
  brilliant: 'Brilliant',
  great: 'Great',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  miss: 'Miss',
  blunder: 'Blunder',
};

function formatEval(evalCp: number | null, evalMate: number | null): string {
  if (evalMate !== null) return `M${Math.abs(evalMate)}`;
  if (evalCp === null) return '–';
  const pawns = (evalCp / 100).toFixed(2);
  return evalCp > 0 ? `+${pawns}` : pawns;
}

function EnginePanel({
  fen,
  analysis,
  classification,
  explanation,
  slmState,
  onRequestDeepDive,
  loading = false,
  progressPercent = null,
  practice = null,
  canPractice = false,
  practiceBestSan = '',
  onStartPractice,
  onRevealPractice,
  onExitPractice,
}: EnginePanelProps) {
  const motifLabel = explanation?.motif ? MOTIF_LABELS[explanation.motif] : undefined;

  const bestSan = useMemo(() => {
    return analysis && analysis.bestMove ? uciToSan(fen, analysis.bestMove) : '–';
  }, [fen, analysis?.bestMove]);

  // Newest attempt only — see the comment on the practice block below.
  const last = practice && practice.attempts.length > 0
    ? practice.attempts[practice.attempts.length - 1]
    : null;

  const winChance = useMemo(() => {
    if (!analysis) return null;
    if (analysis.evalCp === null && analysis.evalMate === null) return null;
    return Math.round(winPercent(toCpValue(analysis.evalCp, analysis.evalMate)));
  }, [analysis?.evalCp, analysis?.evalMate]);

  // What is now coming at the player, as opposed to what their own move
  // did. Only shown when there is something concrete to name.
  const threat = useMemo(() => describeThreat(fen), [fen]);

  /** Collapsed shows the verdict and one sentence; everything else is a
   *  tap away. The board is the thing that should own the screen, and
   *  this panel was taking a third of it to restate the same move in six
   *  registers. Resets on every move so stepping never inherits an
   *  expanded box from the move before. */
  const tr = useT();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [fen]);

  const pvSan = useMemo(() => {
    return analysis && analysis.pv.length > 0 ? pvToSan(fen, analysis.pv.slice(0, 8)).join(' ') : '';
  }, [fen, analysis?.pv]);

  return (
    <div className="insight">
      <div className="insight-top">
        <div className={`insight-eval${loading && !analysis ? ' is-waiting' : ''}`}>
          {loading && !analysis
            ? `Analysing${progressPercent !== null ? ` · ${progressPercent}%` : '…'}`
            : formatEval(analysis?.evalCp ?? null, analysis?.evalMate ?? null)}
          {/* "+1.40" means little below about 1500. The win probability
              says the same thing in a unit anyone can act on, and it also
              explains why the same slip matters less from a winning
              position than from a level one. */}
          {!loading && analysis && winChance !== null && (
            <span className="insight-odds">{winChance}% for White</span>
          )}
        </div>

        {(classification || motifLabel) && (
          <div className="insight-badges">
            {classification && (
              <span className={`badge badge-${classification}`}>
                {CLASSIFICATION_LABELS[classification]}
              </span>
            )}
            {motifLabel && <span className="badge badge-motif">{motifLabel}</span>}
          </div>
        )}
      </div>

      {explanation && !practice && (
        <div className="insight-block insight-body" key={explanation.title + explanation.summary}>
          {/* "Why this matters" was a label that never said anything the
              sentence under it did not. The practice action stays, because
              it is the one thing here you can act on. */}
          {canPractice && onStartPractice && (
            <div className="insight-kicker">
              <button type="button" className="kicker-action" onClick={onStartPractice}>
                {tr('review.tryIt')}
              </button>
            </div>
          )}
          <div className="insight-title">{explanation.title}</div>
          <p className="insight-summary">{explanation.summary}</p>

          {expanded && (
            <>
              <p className="insight-detail">{explanation.detail}</p>
              {threat && <p className="insight-threat">{threat}</p>}
              {/* Built from the arrows actually on the board, so it never
                  explains a colour that is not there. Four colours with
                  fixed meanings are learnable; an unexplained fan of
                  arrows is not. */}
              {explanation.shapes.length > 0 && (
                <ul className="arrow-key">
                  {(
                    [
                      ['blue', tr('arrows.you')],
                      ['green', tr('arrows.best')],
                      ['yellow', tr('arrows.threat')],
                      ['red', tr('arrows.danger')],
                    ] as const
                  )
                    .filter(([brush]) => explanation.shapes.some((s) => s.brush === brush))
                    .map(([brush, label]) => (
                      <li key={brush}>
                        <span className={`arrow-dot is-${brush}`} />
                        {label}
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}

          <button
            type="button"
            className="insight-more"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? tr('review.less') : tr('review.more')}
            <IconChevronRight className={expanded ? 'is-open' : undefined} />
          </button>
        </div>
      )}

      {practice && (
        <div className="insight-block insight-body">
          <div className="insight-kicker">
            <span>Your move</span>
            <button type="button" className="kicker-action" onClick={onExitPractice}>
              Done
            </button>
          </div>

          {last ? (
            <>
              <div className={`insight-title practice-line ${VERDICT_COPY[last.verdict].tone}`}>
                <span>{last.san}</span>
                <span className="practice-title-verdict">{VERDICT_COPY[last.verdict].title}</span>
                {last.lossCp > 0 && (
                  <span className="practice-title-loss num">−{(last.lossCp / 100).toFixed(2)}</span>
                )}
              </div>
              {/* Only the newest attempt is shown. Listing every try grew
                  the card on each move and pushed everything below it. */}
              <p className="insight-summary">
                {last.reason ?? (last.verdict === 'best'
                  ? 'That is the move the engine plays here.'
                  : 'A reasonable try, though the engine still prefers its own move.')}
              </p>
            </>
          ) : (
            <>
              <div className="insight-title">Play the move you think is best</div>
              <p className="insight-summary">
                {practice.status === 'judging' ? 'Checking…' : 'The board is live. Drag a piece.'}
              </p>
            </>
          )}

          <p className="insight-detail">
            {practice.status === 'revealed'
              ? `The engine played ${practiceBestSan}.`
              : practice.error ??
                (practice.attempts.length > 1
                  ? `${practice.attempts.length} attempts so far.`
                  : 'Keep trying, or reveal the answer.')}
          </p>

          {practice.status !== 'revealed' && practice.attempts.length > 0 && onRevealPractice && (
            <button type="button" className="kicker-action practice-reveal-inline" onClick={onRevealPractice}>
              Show the answer
            </button>
          )}
        </div>
      )}

      {/* Everything from here down is detail: the depth the engine
          reached, the line it wants, and the on-demand model. Useful when
          you go looking, noise on every single move. */}
      {expanded && onRequestDeepDive && !slmState && (
        <button type="button" className="deep-dive-btn" onClick={onRequestDeepDive}>
          Explain in depth (experimental)
        </button>
      )}

      {slmState && (
        <div className="insight-block">
          <div className="insight-kicker">
            <span>AI explanation</span>
            {slmState.status === 'done' && slmState.elapsedMs !== undefined && (
              <span>{slmState.elapsedMs}ms</span>
            )}
          </div>
          {slmState.status === 'loading' && <p className="insight-summary">Generating…</p>}
          {slmState.status === 'unavailable' && (
            <p className="insight-summary">Not bundled in this build.</p>
          )}
          {slmState.status === 'error' && (
            <p className="insight-summary">Generation failed: {slmState.error}</p>
          )}
          {slmState.status === 'done' && (
            <>
              <p className="insight-summary">{slmState.text}</p>
              {slmState.warning && (
                <p className="insight-detail insight-warning">{slmState.warning}</p>
              )}
            </>
          )}
        </div>
      )}

      {expanded && (
        <>
          <div className="insight-meta">
            <span>Depth {analysis?.depth ?? '–'}</span>
            <span>Best <strong>{bestSan}</strong></span>
          </div>
          {pvSan && <div className="insight-pv" title={pvSan}>{pvSan}</div>}
        </>
      )}
    </div>
  );
}

// Only meaningful because App passes a stable `onRequestDeepDive` — an
// inline arrow there would change identity every render and defeat this.
export default memo(EnginePanel);
