import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BoardStage from './components/BoardStage';
import HomeFlow from './components/HomeFlow';
import PieceField from './components/PieceField';
import MoveList from './components/MoveList';
import MoveStrip from './components/MoveStrip';
import ReviewOverlay from './components/ReviewOverlay';
import SettingsScreen from './components/SettingsScreen';
import AssetGate from './components/AssetGate';
import { useAssets } from './lib/assets';
import EnginePanel from './components/EnginePanel';
import GameGraph from './components/GameGraph.tsx';
import {
  IconBack,
  IconFlip,
  IconTarget,
  IconChart,
  IconClock,
  IconChevronDown,
  IconSettings,
} from './components/icons';
import { parsePgn, type ParsedGame } from './lib/parsePgn';
import {
  EMPTY_ACCURACY_ACCUMULATOR,
  finalizeAccuracy,
  reviewGame,
  reviewMove,
  type AccuracyAccumulator,
  type GameReview,
  type ReviewedMove,
} from './lib/reviewEngine.ts';
import {
  buildSummary,
  listReviews,
  loadReview,
  reviewId,
  saveReview,
  type ReviewSummary,
} from './lib/storage.ts';
import { bestMoveSan, judgeAttempt, type PracticeAttempt } from './lib/practice.ts';

const PRACTICABLE: ReadonlySet<string> = new Set([
  'inaccuracy',
  'mistake',
  'blunder',
  'miss',
]);

interface PracticeSession {
  moveIndex: number;
  fenBefore: string;
  attempts: PracticeAttempt[];
  status: 'awaiting' | 'judging' | 'revealed';
  error?: string;
}
import type {
  AnalysisResult,
  EngineInfo,
  ReviewCompletePayload,
  ReviewErrorPayload,
  ReviewProgressPayload,
} from './lib/analysis.ts';
import type { BoardShape } from './lib/explanations.ts';
import { generateSlmExplanation, numericMismatch, type MoveFacts, type SlmState } from './lib/slm.ts';
import { describeMoment, findCriticalMoments } from './lib/criticalMoments.ts';
import { useT } from './lib/i18n.ts';
import {
  hasUsableAnalysis,
  toAnalysisResults,
  type LichessAnalysisEntry,
} from './lib/lichessAnalysis.ts';
import { parseTimeControl, timeInsights, timeSpentPerMove, RUSHED_SECONDS } from './lib/clock.ts';
import { bookExitPly, openingFrom } from './lib/openings.ts';
import { PHASE_LABELS, phaseAccuracy, phasesFor } from './lib/phases.ts';
import {
  applySettings,
  loadSettings,
  resolveTheme,
  saveSettings,
  type Settings,
} from './lib/settings.ts';
import './App.css';

type ReviewMode = 'fast' | 'deep';

const CLASSIFICATION_LABELS: Record<string, string> = {
  brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent',
  good: 'Good', book: 'Book', inaccuracy: 'Inaccuracy', mistake: 'Mistake',
  miss: 'Miss', blunder: 'Blunder',
};

function accuracyBand(value: number): string {
  if (value >= 95) return 'brilliant';
  if (value >= 90) return 'best';
  if (value >= 80) return 'excellent';
  if (value >= 70) return 'good';
  if (value >= 60) return 'inaccuracy';
  if (value >= 45) return 'mistake';
  return 'blunder';
}

function evalToPercent(evalCp: number | null, evalMate: number | null): number {
  if (evalMate !== null) return evalMate > 0 ? 100 : 0;
  if (evalCp === null) return 50;
  return 50 + (Math.max(-1000, Math.min(1000, evalCp)) / 1000) * 50;
}

const REVIEW_SETTINGS: Record<ReviewMode, { depth: number; multiPv: number }> = {
  fast: { depth: 10, multiPv: 1 },
  deep: { depth: 14, multiPv: 2 },
};

function App() {
  const tr = useT();
  const [game, setGame] = useState<ParsedGame | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[] | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ current: number; total: number } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>(() => loadSettings().depth);
  const [extra, setExtra] = useState<'graph' | 'time' | null>(null);
  const [homeNav, setHomeNav] = useState<{
    title: string;
    onBack: (() => void) | null;
    onTitleTap?: (() => void) | null;
  }>({ title: '', onBack: null });
  const [accountMenu, setAccountMenu] = useState(false);

  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (settings.theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applySettings(settings);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [settings]);
  const [showArrows, setShowArrows] = useState(true);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  const [slmExplanations, setSlmExplanations] = useState<Record<number, SlmState>>({});

  const autoReviewedGame = useRef<ParsedGame | null>(null);
  const reviewRequest = useRef(0);

  const [currentPgn, setCurrentPgn] = useState<string>('');
  const [recentReviews, setRecentReviews] = useState<ReviewSummary[]>([]);
  const [practice, setPractice] = useState<PracticeSession | null>(null);
  const [reviewSource, setReviewSource] = useState<'engine' | 'lichess'>('engine');

  const assets = useAssets();

  const refreshRecent = useCallback(() => {
    listReviews()
      .then(setRecentReviews)
      .catch(() => setRecentReviews([]));
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  useEffect(() => {
    invoke<EngineInfo>('check_engine', { enginePath: null })
      .then((info) => setEngineInfo(info))
      .catch((err) => {
        console.error('Failed to probe engine:', err);
        setEngineInfo({
          available: false,
          name: null,
          path: 'stockfish',
          error: String(err),
        });
      });
  }, []);

  const handleImport = (pgn: string, analysis?: LichessAnalysisEntry[]) => {
    reviewRequest.current += 1;
    try {
      void invoke('cancel_review').catch(() => {});
    } catch {
    }

    try {
      const parsed = parsePgn(pgn);
      setCurrentPgn(pgn);
      setCurrentIndex(-1);
      setReviewProgress(null);
      setReviewError(null);
      setSlmExplanations({});

      if (hasUsableAnalysis(analysis, parsed)) {
        const imported = toAnalysisResults(analysis!, parsed);
        const built = reviewGame(parsed, imported);
        autoReviewedGame.current = parsed;
        setGame(parsed);
        setAnalysisResults(imported);
        setReview(built);
        setReviewSource('lichess');

        const id = reviewId(pgn);
        void saveReview({
          summary: buildSummary(id, parsed, built),
          pgn,
          analysis: imported,
          depth: 0,
          multiPv: 1,
        })
          .then(refreshRecent)
          .catch((err) => console.error('Could not save this review:', err));
      } else {
        setGame(parsed);
        setAnalysisResults(null);
        setReview(null);
        setReviewSource('engine');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Could not parse that PGN: ${message}`);
      console.error(err);
    }
  };

  const runReview = async (gameToReview: ParsedGame) => {
    const requestId = ++reviewRequest.current;
    const pgnToSave = currentPgn;
    setReviewing(true);
    setReviewProgress({ current: 0, total: gameToReview.moves.length + 1 });
    setReviewError(null);
    setReview(null);
    setAnalysisResults(null);
    setSlmExplanations({});
    setReviewSource('engine');

    const localAnalysis: (AnalysisResult | null)[] = new Array(gameToReview.moves.length + 1).fill(null);
    let accumulator: AccuracyAccumulator = EMPTY_ACCURACY_ACCUMULATOR;
    let nextMoveToClassify = 0;
    const classified: ReviewedMove[] = [];

    const unlistenFns: Array<() => void> = [];
    try {
      const fens = [gameToReview.startingFen, ...gameToReview.moves.map((m) => m.fenAfter)];

      unlistenFns.push(
        await listen<ReviewProgressPayload>('review-progress', (event) => {
          if (event.payload.runId !== requestId) return;
          if (requestId !== reviewRequest.current) return;
          const { index, total, result } = event.payload;
          localAnalysis[index] = result;

          setReviewProgress({ current: index + 1, total });
          setAnalysisResults((prev) => {
            const updated = prev ? [...prev] : new Array(total).fill(null);
            updated[index] = result;
            return updated;
          });

          const newlyReviewed: ReviewedMove[] = [];
          while (nextMoveToClassify < gameToReview.moves.length) {
            const before = localAnalysis[nextMoveToClassify];
            const after = localAnalysis[nextMoveToClassify + 1];
            if (!before || !after) break;
            const result = reviewMove(gameToReview, nextMoveToClassify, before, after, accumulator);
            accumulator = result.accumulator;
            newlyReviewed.push(result.reviewedMove);
            classified.push(result.reviewedMove);
            nextMoveToClassify += 1;
          }

          if (newlyReviewed.length > 0) {
            const { whiteAccuracy, blackAccuracy } = finalizeAccuracy(accumulator);
            setReview((prev) => ({
              moves: [...(prev?.moves ?? []), ...newlyReviewed],
              whiteAccuracy,
              blackAccuracy,
            }));
          }
        }),
      );

      let resolveCompletion: () => void = () => {};
      let rejectCompletion: (reason: unknown) => void = () => {};
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      unlistenFns.push(
        await listen<ReviewCompletePayload>('review-complete', (event) => {
          if (event.payload.runId !== requestId) return;
          resolveCompletion();
        }),
      );
      unlistenFns.push(
        await listen<ReviewErrorPayload>('review-error', (event) => {
          if (event.payload.runId !== requestId) return;
          rejectCompletion(new Error(event.payload.message));
        }),
      );

      const settings = REVIEW_SETTINGS[reviewMode];
      await invoke('analyze_game', {
        fens,
        depth: settings.depth,
        enginePath: null,
        multiPv: settings.multiPv,
        runId: requestId,
      });

      await completion;

      const complete = localAnalysis.filter((a): a is AnalysisResult => a !== null);
      if (
        requestId === reviewRequest.current &&
        pgnToSave &&
        complete.length === localAnalysis.length
      ) {
        const finished: GameReview = { moves: classified, ...finalizeAccuracy(accumulator) };
        const id = reviewId(pgnToSave);
        try {
          await saveReview({
            summary: buildSummary(id, gameToReview, finished),
            pgn: pgnToSave,
            analysis: complete,
            depth: settings.depth,
            multiPv: settings.multiPv,
          });
          refreshRecent();
        } catch (saveErr) {
          console.error('Could not save this review:', saveErr);
        }
      }
    } catch (err) {
      if (requestId === reviewRequest.current) setReviewError(String(err));
    } finally {
      unlistenFns.forEach((fn) => fn());
      if (requestId === reviewRequest.current) {
        setReviewing(false);
        setReviewProgress(null);
      }
    }
  };

  const handleReview = async () => {
    if (!game) return;
    await runReview(game);
  };

  const openStoredReview = async (id: string) => {
    try {
      reviewRequest.current += 1;
      void invoke('cancel_review').catch(() => {});

      const stored = await loadReview(id);
      const parsed = parsePgn(stored.pgn);

      autoReviewedGame.current = parsed;

      setCurrentPgn(stored.pgn);
      setGame(parsed);
      setAnalysisResults(stored.analysis);
      setReview(reviewGame(parsed, stored.analysis));
      setCurrentIndex(-1);
      setReviewError(null);
      setReviewProgress(null);
      setReviewing(false);
      setSlmExplanations({});
    } catch (err) {
      alert(`Could not open that saved review: ${err}`);
    }
  };

  useEffect(() => {
    if (!game || autoReviewedGame.current === game) return;
    autoReviewedGame.current = game;
    const reviewTimer = window.setTimeout(() => {
      void runReview(game);
    }, 120);
    return () => window.clearTimeout(reviewTimer);
  }, [game]);

  useEffect(() => {
    return () => {
      void invoke('cancel_review').catch(() => {});
    };
  }, []);

  const goToStart = () => setCurrentIndex(-1);
  const goToEnd = () => game && setCurrentIndex(game.moves.length - 1);
  const goToPrevious = () => setCurrentIndex((i) => Math.max(-1, i - 1));
  const goToNext = () =>
    setCurrentIndex((i) => (game ? Math.min(game.moves.length - 1, i + 1) : i));

  const goBackToImport = () => {
    reviewRequest.current += 1;
    void invoke('cancel_review').catch(() => {});
    setGame(null);
    setCurrentIndex(-1);
    setAnalysisResults(null);
    setReview(null);
    setReviewProgress(null);
    setReviewError(null);
    setSlmExplanations({});
  };

  const toggleOrientation = () => {
    setBoardOrientation((prev) => (prev === 'white' ? 'black' : 'white'));
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!game) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      )
        return;
      if (e.key === 'ArrowLeft') goToPrevious();
      if (e.key === 'ArrowRight') goToNext();
      if (e.key === 'f' || e.key === 'F') toggleOrientation();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [game, currentIndex]);

  const currentFen = game
    ? currentIndex === -1
      ? game.startingFen
      : game.moves[currentIndex].fenAfter
    : null;

  const currentAnalysis = analysisResults ? analysisResults[currentIndex + 1] : null;
  const currentClassification =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.classification : undefined;
  const currentExplanation =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.explanation : undefined;
  const currentSlmFacts =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.slmFacts : undefined;
  const currentSlmState = currentIndex >= 0 ? slmExplanations[currentIndex] : undefined;
  const isReviewComplete = !!game && (review?.moves.length ?? 0) === game.moves.length;

  const analysisBeforeCurrent = analysisResults ? analysisResults[currentIndex] : null;
  const fenBeforeCurrent =
    game && currentIndex >= 0
      ? currentIndex === 0
        ? game.startingFen
        : game.moves[currentIndex - 1].fenAfter
      : null;
  const canPractice =
    !!currentClassification &&
    PRACTICABLE.has(currentClassification) &&
    !!analysisBeforeCurrent &&
    !!fenBeforeCurrent &&
    !reviewing;

  const practiceBestSan =
    fenBeforeCurrent && analysisBeforeCurrent
      ? bestMoveSan(fenBeforeCurrent, analysisBeforeCurrent)
      : '';

  const startPractice = () => {
    if (!canPractice || !fenBeforeCurrent) return;
    setPractice({
      moveIndex: currentIndex,
      fenBefore: fenBeforeCurrent,
      attempts: [],
      status: 'awaiting',
    });
  };

  const exitPractice = () => setPractice(null);

  const revealPracticeAnswer = () =>
    setPractice((prev) => (prev ? { ...prev, status: 'revealed' } : prev));

  const handlePracticeMove = async (from: string, to: string) => {
    if (!practice || !analysisBeforeCurrent || practice.status === 'judging') return;
    setPractice((prev) => (prev ? { ...prev, status: 'judging', error: undefined } : prev));
    try {
      const attempt = await judgeAttempt(
        practice.fenBefore,
        from,
        to,
        analysisBeforeCurrent,
        REVIEW_SETTINGS[reviewMode].depth,
      );
      setPractice((prev) => {
        if (!prev || prev.moveIndex !== practice.moveIndex) return prev;
        if (!attempt) {
          return { ...prev, status: 'awaiting', error: 'That move was not legal here.' };
        }
        return {
          ...prev,
          attempts: [...prev.attempts, attempt],
          status: attempt.verdict === 'best' ? 'revealed' : 'awaiting',
        };
      });
    } catch (err) {
      setPractice((prev) =>
        prev ? { ...prev, status: 'awaiting', error: `Could not evaluate that move: ${err}` } : prev,
      );
    }
  };

  useEffect(() => {
    setPractice((prev) => (prev && prev.moveIndex !== currentIndex ? null : prev));
  }, [currentIndex]);

  const requestSlmDeepDive = useCallback((index: number, facts: MoveFacts) => {
    setSlmExplanations((prev) => ({ ...prev, [index]: { status: 'loading' } }));
    generateSlmExplanation(facts)
      .then((result) => {
        const warning = numericMismatch(facts, result.text) ?? undefined;
        setSlmExplanations((prev) => ({
          ...prev,
          [index]: { status: 'done', text: result.text, elapsedMs: result.elapsedMs, warning },
        }));
      })
      .catch((err) => {
        const message = String(err);
        const unavailable = message.includes('SLM model not found') || message.includes('SLM not available');
        setSlmExplanations((prev) => ({
          ...prev,
          [index]: { status: unavailable ? 'unavailable' : 'error', error: message },
        }));
      });
  }, []);

  const handleRequestDeepDive = useMemo(() => {
    if (currentIndex < 0 || !currentSlmFacts) return undefined;
    const index = currentIndex;
    const facts = currentSlmFacts;
    return () => requestSlmDeepDive(index, facts);
  }, [currentIndex, currentSlmFacts, requestSlmDeepDive]);

  const timeSpent = useMemo(() => {
    if (!game) return [];
    const { base, increment } = parseTimeControl(game.headers.TimeControl);
    return timeSpentPerMove(game, game.moves.map((m) => m.clock ?? null), increment, base);
  }, [game]);

  const clockSummary = useMemo(() => {
    if (!game || !review || review.moves.length === 0) return null;
    const classes = review.moves.map((m) => m.classification);
    const colors = review.moves.map((m) => m.color);
    return {
      white: timeInsights(timeSpent, classes, colors, 'w'),
      black: timeInsights(timeSpent, classes, colors, 'b'),
    };
  }, [game, review, timeSpent]);

  const opening = useMemo(() => {
    if (!game) return null;
    const info = openingFrom(game.headers);
    if (!info.name && !info.eco) return null;
    return { ...info, exitPly: bookExitPly(game) };
  }, [game]);

  const phaseSplit = useMemo(() => {
    if (!review || review.moves.length === 0) return null;
    const phases = phasesFor(review, opening?.exitPly ?? null);
    return {
      white: phaseAccuracy(review, phases, 'w'),
      black: phaseAccuracy(review, phases, 'b'),
    };
  }, [review, opening]);

  const criticalMoments = useMemo(
    () => (review && isReviewComplete ? findCriticalMoments(review, 3) : []),
    [review, isReviewComplete],
  );

  const displayMoves = useMemo(() => {
    if (!game) return [];
    if (!review) return game.moves;
    return game.moves.map((m, i) => review.moves[i] ?? m);
  }, [game, review]);

  const currentShapes = useMemo<BoardShape[]>(() => {
    if (currentIndex < 0) return [];
    if (practice && practice.status !== 'revealed') return [];
    if (!showArrows) return [];
    if (currentExplanation?.shapes && currentExplanation.shapes.length > 0) {
      return currentExplanation.shapes;
    }
    if (currentAnalysis?.bestMove && currentAnalysis.bestMove.length >= 4) {
      return [
        {
          orig: currentAnalysis.bestMove.slice(0, 2),
          dest: currentAnalysis.bestMove.slice(2, 4),
          brush: 'green',
        },
      ];
    }
    return [];
  }, [showArrows, currentExplanation?.shapes, currentAnalysis?.bestMove, practice, currentIndex]);

  const progressPercent = reviewProgress
    ? Math.round((reviewProgress.current / reviewProgress.total) * 100)
    : null;

  const canPrevious = currentIndex > -1;
  const canNext = !!game && currentIndex < game.moves.length - 1;

  const hasClockData = !!clockSummary && !!(clockSummary.white || clockSummary.black);

  const atHome = !game && !showSettings && homeNav.onBack === null;

  const evalPercent = evalToPercent(
    currentAnalysis?.evalCp ?? null,
    currentAnalysis?.evalMate ?? null,
  );

  return (
    <div className="app">
      {}
      {}
      <PieceField
        mode={settings.motion === 'static' || game ? 'static' : 'live'}
        theme={resolveTheme(settings.theme)}
      />

      <header className={`topbar${atHome ? '' : ' glass'}`}>
        {}
        {}
        {atHome ? (
          <span className="brand">
            <span>Chesy</span>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn"
            onClick={
              showSettings
                ? () => setShowSettings(false)
                : game
                  ? goBackToImport
                  : homeNav.onBack ?? undefined
            }
            aria-label={tr('nav.back')}
            title={tr('nav.back')}
          >
            <IconBack />
          </button>
        )}

        <div className="topbar-title">
          {!game && homeNav.onTitleTap ? (
            <button
              type="button"
              className="title-action"
              onClick={() => setAccountMenu((v) => !v)}
              aria-expanded={accountMenu}
              aria-haspopup="menu"
            >
              <span className="players">{homeNav.title}</span>
              <IconChevronDown className={accountMenu ? 'is-open' : undefined} />
            </button>
          ) : null}

          {accountMenu && homeNav.onTitleTap && (
            <>
              <div className="menu-scrim" onPointerDown={() => setAccountMenu(false)} />
              {}
              <div className="account-menu glass" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    homeNav.onTitleTap?.();
                    setAccountMenu(false);
                  }}
                >
                  {tr('connect.switch')}
                </button>
              </div>
            </>
          )}

          {!(!game && homeNav.onTitleTap) && (
            <span className="players muted">
              {showSettings
                ? tr('nav.settings')
                : game
                  ? `${game.headers.White ?? '?'} vs ${game.headers.Black ?? '?'}`
                  : homeNav.title}
            </span>
          )}
        </div>

        <div className="topbar-actions">
          {}
          {game && (
            <>
              <button
                type="button"
                className={`icon-btn ${showArrows ? 'is-active' : ''}`}
                onClick={() => setShowArrows(!showArrows)}
                aria-pressed={showArrows}
                aria-label="Toggle tactical arrows"
                title="Toggle tactical arrows and motif highlights"
              >
                <IconTarget />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={toggleOrientation}
                aria-label={`Flip board (showing ${boardOrientation})`}
                title="Flip the board (hotkey: F)"
              >
                <IconFlip />
              </button>
            </>
          )}

          {}
          {engineInfo && !engineInfo.available && (
            <span className="status-pill is-warning">
              <span className="status-dot" />
              <span className="status-label">Stockfish not detected</span>
            </span>
          )}

          {atHome && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowSettings(true)}
              aria-label={tr('nav.settings')}
              title={tr('nav.settings')}
            >
              <IconSettings />
            </button>
          )}
        </div>
      </header>

      {showSettings && (
        <SettingsScreen settings={settings} onChange={setSettings} />
      )}

      {}
      {!game && !showSettings && assets.missing.length > 0 && (
        <AssetGate assets={assets} />
      )}

      {!game && !showSettings && assets.assets !== null && assets.missing.length === 0 && (
        <HomeFlow
          onImport={handleImport}
          recent={recentReviews}
          onOpenRecent={(id) => void openStoredReview(id)}
          onNav={setHomeNav}
        />
      )}

      {game && currentFen && (
        <main className="review">
          {}
          <section className="band band-insight glass">
            <EnginePanel
              fen={currentFen}
              analysis={currentAnalysis}
              classification={currentClassification}
              explanation={currentExplanation}
              slmState={currentSlmState}
              onRequestDeepDive={handleRequestDeepDive}
              loading={reviewing}
              progressPercent={progressPercent}
              practice={practice}
              canPractice={canPractice}
              practiceBestSan={practiceBestSan}
              onStartPractice={startPractice}
              onRevealPractice={revealPracticeAnswer}
              onExitPractice={exitPractice}
            />

            {!isReviewComplete && (
              <div className="review-actions">
                <div className="mode-toggle" role="group" aria-label="Review depth">
                  <button
                    type="button"
                    className={`chip-btn ${reviewMode === 'fast' ? 'is-active' : ''}`}
                    onClick={() => setReviewMode('fast')}
                    disabled={reviewing}
                    title="Depth 10, single line. Faster, but no Great/Brilliant detection. Best for weaker hardware."
                  >
                    Fast
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${reviewMode === 'deep' ? 'is-active' : ''}`}
                    onClick={() => setReviewMode('deep')}
                    disabled={reviewing}
                    title="Depth 14, two lines. Full classification including Great/Brilliant, but slower."
                  >
                    Deep
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={handleReview}
                  disabled={reviewing}
                >
                  {reviewing
                    ? tr('review.reviewing', { percent: progressPercent ?? 0 })
                    : review
                      ? tr('review.retry')
                      : tr('review.reviewGame')}
                </button>
              </div>
            )}

            {reviewError && <div className="notice">{reviewError}</div>}
          </section>

          <section className="band band-board">
            {reviewing && reviewProgress && (
              <div className="progress">
                <div className="progress-label">
                  <span>
                    {tr('review.evaluating', { current: reviewProgress.current, total: reviewProgress.total })}
                  </span>
                  <span className="numeric">{progressPercent}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            <BoardStage
              fen={practice ? practice.fenBefore : currentFen}
              evalPercent={evalPercent}
              shapes={currentShapes}
              orientation={boardOrientation}
              canPrevious={canPrevious}
              canNext={canNext}
              onPrevious={goToPrevious}
              onNext={goToNext}
              onStart={goToStart}
              onEnd={goToEnd}
              interactive={!!practice && practice.status !== 'revealed'}
              onMove={handlePracticeMove}
            />
          </section>

          {}
          <MoveStrip
            moves={displayMoves}
            currentIndex={currentIndex}
            onSelect={setCurrentIndex}
          />

          <div className="extras">
            <button
              type="button"
              className="extra-btn"
              onClick={() => setExtra('graph')}
              disabled={!review}
            >
              <IconChart />
              <span>{tr('review.graph')}</span>
            </button>
            <button
              type="button"
              className="extra-btn"
              onClick={() => setExtra('time')}
              disabled={!hasClockData}
            >
              <IconClock />
              <span>{tr('review.time')}</span>
            </button>
          </div>

          {}
          <aside className="detail">
            {review && (
              <>
                <div className="accuracy">
                  {([
                    ['White', review.whiteAccuracy],
                    ['Black', review.blackAccuracy],
                  ] as const).map(([side, value]) => (
                    <div className="accuracy-cell" key={side}>
                      <span className="eyebrow">{side}{!isReviewComplete ? ' so far' : ''}</span>
                      <span className="accuracy-value">{value.toFixed(1)}%</span>
                      {}
                      <span className="accuracy-bar">
                        <span
                          className={`accuracy-fill accuracy-${accuracyBand(value)}`}
                          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <MoveList moves={displayMoves} currentIndex={currentIndex} onSelect={setCurrentIndex} />
          </aside>

          {extra === 'graph' && review && (
            <ReviewOverlay
              title={tr('review.positionMap')}
              subtitle={tr('review.positionMap.help')}
              onClose={() => setExtra(null)}
            >
              <div className="graph-meta">
                {opening && (
                  <span className="opening-tag">
                    {opening.name ?? opening.eco}
                    {opening.exitPly !== null && (
                      <span className="opening-exit num">
                        {' '}· book to {Math.floor(opening.exitPly / 2) + 1}
                      </span>
                    )}
                  </span>
                )}
                {}
                {reviewSource === 'lichess' && (
                  <span className="source-tag">via Lichess</span>
                )}
                <span className="graph-readout">
                  {currentIndex >= 0 && review.moves[currentIndex] ? (
                    <>
                      <span className="graph-readout-move">
                        {review.moves[currentIndex].moveNumber}
                        {review.moves[currentIndex].color === 'w' ? '.' : '…'}{' '}
                        {review.moves[currentIndex].san}
                      </span>
                      <span className={`graph-readout-tag c-${review.moves[currentIndex].classification}`}>
                        {CLASSIFICATION_LABELS[review.moves[currentIndex].classification]}
                      </span>
                    </>
                  ) : (
                    <span className="graph-readout-move faint">Starting position</span>
                  )}
                </span>
              </div>

              {}
              <div className="graph-scroll">
                <div
                  className="graph-track"
                  style={{ minWidth: `${Math.max(300, game.moves.length * 14)}px` }}
                >
                  <GameGraph
                    moves={review.moves}
                    totalMoves={game.moves.length}
                    currentIndex={currentIndex}
                    onSelect={setCurrentIndex}
                  />
                </div>
              </div>

              {}
              {criticalMoments.length > 0 && (
                <div className="moments">
                  <p className="section-label">{tr('review.turningPoints')}</p>
                  <ul className="moments-list">
                    {criticalMoments.map((m) => (
                      <li key={m.index}>
                        <button
                          type="button"
                          className={`moment${m.index === currentIndex ? ' is-active' : ''}`}
                          onClick={() => { setCurrentIndex(m.index); setExtra(null); }}
                        >
                          <span className={`moment-dot c-${m.move.classification}`} />
                          <span className="moment-move num">
                            {m.move.moveNumber}
                            {m.move.color === 'w' ? '.' : '…'} {m.move.san}
                          </span>
                          <span className="moment-note">{describeMoment(m)}</span>
                          {}
                          <span className="moment-swing num">−{Math.round(m.swing)}%</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {phaseSplit && phaseSplit.white.length > 1 && (
                <div className="phases">
                  <p className="section-label">{tr('review.accuracyByPhase')}</p>
                  {(
                    [
                      ['White', phaseSplit.white],
                      ['Black', phaseSplit.black],
                    ] as const
                  ).map(([side, rows]) => (
                    <div className="phase-row" key={side}>
                      <span className="phase-side">{side}</span>
                      {rows.map((r) => (
                        <span className="phase-cell" key={r.phase}>
                          <span className="phase-name">{PHASE_LABELS[r.phase]}</span>
                          <span className={`phase-value num c-${accuracyBand(r.accuracy)}`}>
                            {r.accuracy.toFixed(0)}%
                          </span>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </ReviewOverlay>
          )}

          {extra === 'time' && hasClockData && (
            <ReviewOverlay
              title={tr('review.timeSpent')}
              subtitle={tr('review.timeSpent.help')}
              onClose={() => setExtra(null)}
            >
              <div className="clocks">
                {(
                  [
                    ['White', clockSummary!.white],
                    ['Black', clockSummary!.black],
                  ] as const
                ).map(([side, ins]) =>
                  ins ? (
                    <div className="clock-row" key={side}>
                      <span className="clock-side">{side}</span>
                      <span className="clock-stat num">{ins.medianSeconds.toFixed(1)}s</span>
                      <span className="clock-label">median</span>
                      {}
                      {ins.totalMistakes > 0 && (
                        <span className="clock-rushed">
                          {ins.rushedMistakes}/{ins.totalMistakes} costly moves rushed
                        </span>
                      )}
                    </div>
                  ) : null,
                )}
              </div>

              {currentIndex >= 0 &&
                timeSpent[currentIndex] !== null &&
                timeSpent[currentIndex] !== undefined && (
                  <p className="clock-current">
                    This move took{' '}
                    <strong className={timeSpent[currentIndex]! < RUSHED_SECONDS ? 'is-rushed' : ''}>
                      {timeSpent[currentIndex]! < 10
                        ? `${timeSpent[currentIndex]!.toFixed(1)}s`
                        : `${Math.round(timeSpent[currentIndex]!)}s`}
                    </strong>
                    {timeSpent[currentIndex]! < RUSHED_SECONDS && ', played almost instantly.'}
                  </p>
                )}
            </ReviewOverlay>
          )}
        </main>
      )}
    </div>
  );
}

export default App;
