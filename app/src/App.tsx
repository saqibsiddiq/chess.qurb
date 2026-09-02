import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BoardStage from './components/BoardStage';
import HomeFlow from './components/HomeFlow';
import MoveList from './components/MoveList';
import EnginePanel from './components/EnginePanel';
import GameGraph from './components/GameGraph.tsx';
import {
  ChesyMark,
  IconBack,
  IconChevronLeft,
  IconChevronRight,
  IconFlip,
  IconSkipEnd,
  IconSkipStart,
  IconSun,
  IconMoon,
  IconTarget,
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

/// Practice is only offered where there was actually something better to
/// find — replaying a position whose move was already best teaches
/// nothing and would make the button noise on most moves.
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
import { applyTheme, initialTheme, type Theme } from './lib/theme.ts';
import './App.css';

type ReviewMode = 'fast' | 'deep';

/** Which pane the side column shows; only meaningful below 1280px, where
 *  there is no room to show the insight card and the move list at once. */
type Pane = 'insight' | 'moves';

const CLASSIFICATION_LABELS: Record<string, string> = {
  brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent',
  good: 'Good', book: 'Book', inaccuracy: 'Inaccuracy', mistake: 'Mistake',
  miss: 'Miss', blunder: 'Blunder',
};

/** Buckets an accuracy percentage onto the classification colour ramp, so
 *  the same colours mean the same thing on a move badge and on a bar. */
function accuracyBand(value: number): string {
  if (value >= 95) return 'brilliant';
  if (value >= 90) return 'best';
  if (value >= 80) return 'excellent';
  if (value >= 70) return 'good';
  if (value >= 60) return 'inaccuracy';
  if (value >= 45) return 'mistake';
  return 'blunder';
}

/** White's share of the evaluation, for the vertical rail beside the board. */
function evalToPercent(evalCp: number | null, evalMate: number | null): number {
  if (evalMate !== null) return evalMate > 0 ? 100 : 0;
  if (evalCp === null) return 50;
  return 50 + (Math.max(-1000, Math.min(1000, evalCp)) / 1000) * 50;
}

// Fast skips MultiPV entirely (no Great/Brilliant detection, ~2x less
// engine time per position) for weaker hardware; Deep is the original
// full-fidelity setting. Depth also drops in Fast mode since it's the
// other big lever on engine time per position.
const REVIEW_SETTINGS: Record<ReviewMode, { depth: number; multiPv: number }> = {
  fast: { depth: 10, multiPv: 1 },
  deep: { depth: 14, multiPv: 2 },
};

function App() {
  const [game, setGame] = useState<ParsedGame | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1); // -1 = starting position

  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[] | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ current: number; total: number } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('deep');
  const [activePane, setActivePane] = useState<Pane>('insight');
  // Measured board edge, mirrored here so the stage's other rows can be
  // pinned to the board's width instead of the window's.
  const [boardPx, setBoardPx] = useState(0);
  // The map competes with the board for the shell's fixed height, so it
  // can be folded away when the board matters more.
  const [graphOpen, setGraphOpen] = useState(true);

  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [showArrows, setShowArrows] = useState(true);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  // Keyed by move index. Generated lazily — only for the move currently
  // being viewed, not eagerly for the whole game — so it doesn't compete
  // for CPU with the concurrent Stockfish `analyze_game` search thread,
  // and so latency numbers reflect one isolated call, not queued-up
  // contention. This is a live head-to-head against the always-instant
  // rule-based explanation below it: same facts, both texts shown, to
  // judge quality/speed before deciding whether the SLM should replace
  // or just supplement the rule-based text.
  const [slmExplanations, setSlmExplanations] = useState<Record<number, SlmState>>({});

  const autoReviewedGame = useRef<ParsedGame | null>(null);
  const reviewRequest = useRef(0);

  // The raw PGN is kept because a completed review is saved with it —
  // storage keeps the engine output plus the PGN, and recomputes
  // classifications on load rather than persisting them twice.
  const [currentPgn, setCurrentPgn] = useState<string>('');
  const [recentReviews, setRecentReviews] = useState<ReviewSummary[]>([]);
  const [practice, setPractice] = useState<PracticeSession | null>(null);

  const refreshRecent = useCallback(() => {
    listReviews()
      .then(setRecentReviews)
      // Saved games are a convenience; if storage is unavailable the app
      // still works exactly as it did before it existed.
      .catch(() => setRecentReviews([]));
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  // Check engine availability on startup
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

  const handleImport = (pgn: string) => {
    reviewRequest.current += 1;
    // Stop the engine now rather than waiting for the new game's
    // auto-review to supersede it ~120ms later — and before parsing, so
    // a failed import doesn't leave the previous review running against
    // a game the user has moved on from.
    //
    // Deliberately outside the try below: `invoke` throws synchronously
    // when the Tauri bridge is absent, and inside that try it would be
    // reported to the user as "could not parse that PGN" — blaming a
    // perfectly valid game for an unrelated engine-transport failure.
    try {
      void invoke('cancel_review').catch(() => {});
    } catch {
      // Nothing to cancel if the bridge isn't there.
    }

    try {
      const parsed = parsePgn(pgn);
      setCurrentPgn(pgn);
      setGame(parsed);
      setCurrentIndex(-1);
      setAnalysisResults(null);
      setReview(null);
      setReviewProgress(null);
      setReviewError(null);
      setSlmExplanations({});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Could not parse that PGN: ${message}`);
      console.error(err);
    }
  };

  const runReview = async (gameToReview: ParsedGame) => {
    const requestId = ++reviewRequest.current;
    // Captured now: this closure belongs to the render that set both the
    // game and its PGN, so they're guaranteed to describe the same game
    // even if another import lands while this review is running.
    const pgnToSave = currentPgn;
    setReviewing(true);
    setReviewProgress({ current: 0, total: gameToReview.moves.length + 1 });
    setReviewError(null);
    // A retry must not append newly-classified moves onto a stale
    // partial review from a previous (failed or superseded) run.
    setReview(null);
    setAnalysisResults(null);
    setSlmExplanations({});

    // Per-run local bookkeeping for incremental classification — plain
    // locals rather than state/refs, since only the listener closures
    // created within this one call ever read them, and a fresh run
    // naturally starts with a clean copy.
    const localAnalysis: (AnalysisResult | null)[] = new Array(gameToReview.moves.length + 1).fill(null);
    let accumulator: AccuracyAccumulator = EMPTY_ACCURACY_ACCUMULATOR;
    let nextMoveToClassify = 0;
    // Kept alongside the React state because saving happens the moment
    // the run completes, and a setState from the last progress event
    // isn't guaranteed to have been applied by then.
    const classified: ReviewedMove[] = [];

    const unlistenFns: Array<() => void> = [];
    try {
      const fens = [gameToReview.startingFen, ...gameToReview.moves.map((m) => m.fenAfter)];

      unlistenFns.push(
        await listen<ReviewProgressPayload>('review-progress', (event) => {
          // Two separate guards, both required. `runId` rejects events
          // emitted by a *different* run that is still winding down;
          // `requestId` rejects events arriving for this run after the
          // React side has already moved on. Checking only one leaves a
          // real hole — the old code had neither, so a superseded run's
          // results were silently written into the current game.
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

          // A move is classifiable as soon as both its before/after
          // analysis slots exist. Since Rust emits review-progress
          // strictly in FEN order, moves become classifiable strictly
          // in order too — so review.moves stays a dense growing
          // prefix, never sparse.
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

      // The Rust side runs the actual (potentially minutes-long) engine
      // loop on its own thread and reports completion via events, rather
      // than the invoke() call itself resolving only once everything is
      // done — a long-blocking command handler previously froze the
      // window for the whole review. review-complete/review-error are now
      // pure completion/error signals: every move was already classified
      // incrementally above as its data streamed in, so there's nothing
      // left to do with the payload itself. Fully register both listeners
      // (awaited, not fire-and-forget) before invoking, so there's no
      // window where an event could fire before we're listening for it.
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
      // Passing the run id in (rather than having Rust mint one and
      // return it) avoids a race: the analysis thread starts emitting as
      // soon as the command is invoked, which can beat the invoke()
      // promise resolving, so the listeners above have to already know
      // the id they're filtering for.
      await invoke('analyze_game', {
        fens,
        depth: settings.depth,
        enginePath: null,
        multiPv: settings.multiPv,
        runId: requestId,
      });

      await completion;

      // Persist the finished review so re-opening this game costs a file
      // read instead of another full engine run. Only the engine output
      // is written; classifications are recomputed on load.
      const complete = localAnalysis.filter((a): a is AnalysisResult => a !== null);
      if (
        requestId === reviewRequest.current &&
        pgnToSave &&
        // Only persist a genuinely complete run. `filter` would silently
        // close a gap left by a missing position, shifting every later
        // entry by one — and since the stored analysis is replayed
        // positionally on load, that would produce a review that looks
        // fine but attributes every evaluation to the wrong move.
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
          // A failed save must not look like a failed review — the
          // review itself is complete and on screen either way.
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

  /// Reopens a saved review with no engine work at all: the stored
  /// analysis is replayed through the same classifier a live review uses,
  /// which measured ~30ms for a full game against minutes of Stockfish.
  const openStoredReview = async (id: string) => {
    try {
      reviewRequest.current += 1;
      void invoke('cancel_review').catch(() => {});

      const stored = await loadReview(id);
      const parsed = parsePgn(stored.pgn);

      // Marking it auto-reviewed *before* the state update is what stops
      // the auto-review effect from immediately launching Stockfish over
      // the game we just loaded a review for.
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

  // Closing the window doesn't necessarily tear the engine down on its
  // own, and in dev a hot reload remounts without it — either way, an
  // orphaned review would keep a Stockfish process at full thread count.
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
    // Leaving the review screen with no replacement run to supersede the
    // old one — without an explicit cancel, the engine would keep
    // grinding through the rest of the game nobody is looking at.
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

  // Keyboard navigation
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

  // analysisResults is indexed like the FEN list: [start, after move 1, after move 2, ...]
  const currentAnalysis = analysisResults ? analysisResults[currentIndex + 1] : null;
  // review.moves may be shorter than currentIndex+1 while a review is
  // still in progress (it's a growing prefix, classified in order) — the
  // optional chaining here means "not classified yet," not an error.
  const currentClassification =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.classification : undefined;
  const currentExplanation =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.explanation : undefined;
  const currentSlmFacts =
    review && currentIndex >= 0 ? review.moves[currentIndex]?.slmFacts : undefined;
  const currentSlmState = currentIndex >= 0 ? slmExplanations[currentIndex] : undefined;
  const isReviewComplete = !!game && (review?.moves.length ?? 0) === game.moves.length;

  // The position *before* the current move — what practice replays from,
  // and the baseline its scoring is measured against. Note the index
  // difference from `currentAnalysis`, which is the position after.
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

  // Only needed once a drill is over, but computing it here keeps the
  // SAN conversion (which needs the pre-move position) out of the panel.
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
        // The user may have navigated away or restarted while the engine
        // was thinking; dropping the result is correct in that case.
        if (!prev || prev.moveIndex !== practice.moveIndex) return prev;
        if (!attempt) {
          return { ...prev, status: 'awaiting', error: 'That move was not legal here.' };
        }
        return {
          ...prev,
          attempts: [...prev.attempts, attempt],
          // Finding the engine's move ends the drill; anything else
          // leaves the board open for another try.
          status: attempt.verdict === 'best' ? 'revealed' : 'awaiting',
        };
      });
    } catch (err) {
      setPractice((prev) =>
        prev ? { ...prev, status: 'awaiting', error: `Could not evaluate that move: ${err}` } : prev,
      );
    }
  };

  // Leaving the move ends its drill — a practice board showing one
  // position while the move list highlights another would be incoherent.
  useEffect(() => {
    setPractice((prev) => (prev && prev.moveIndex !== currentIndex ? null : prev));
  }, [currentIndex]);

  // Strictly on-demand: the SLM only ever runs when the user explicitly
  // asks to explain the current move in depth (see EnginePanel's "Explain
  // in depth" button). An earlier version fired this automatically for
  // every move — both for whatever was on screen and eagerly in the
  // background for the rest of the game — which caused real "app not
  // responding" freezes (the SLM's worker competing with Stockfish's own
  // search threads for CPU during the live review). The always-instant
  // rule-based explanation above is the default now; this is opt-in.
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

  // Bound to the current move here rather than inline in the JSX, so the
  // prop keeps a stable identity between renders and EnginePanel's memo
  // can actually skip work. `undefined` (rather than a disabled no-op)
  // is what hides the button entirely when there's nothing to explain.
  const handleRequestDeepDive = useMemo(() => {
    if (currentIndex < 0 || !currentSlmFacts) return undefined;
    const index = currentIndex;
    const facts = currentSlmFacts;
    return () => requestSlmDeepDive(index, facts);
  }, [currentIndex, currentSlmFacts, requestSlmDeepDive]);

  const displayMoves = useMemo(() => {
    if (!game) return [];
    if (!review) return game.moves;
    return game.moves.map((m, i) => review.moves[i] ?? m);
  }, [game, review]);

  // Memoized active board shapes
  const currentShapes = useMemo<BoardShape[]>(() => {
    // Nothing has been played at the starting position, so an engine
    // arrow there is advice about a move the user hasn't reached rather
    // than feedback on one they made.
    if (currentIndex < 0) return [];
    // During a drill the arrows would point straight at the answer, so
    // they stay hidden until it's revealed.
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

  const moveLabel = !game
    ? ''
    : currentIndex === -1
      ? 'Starting position'
      : `${game.moves[currentIndex].moveNumber}${game.moves[currentIndex].color === 'w' ? '.' : '…'} ${game.moves[currentIndex].san}`;

  const evalPercent = evalToPercent(
    currentAnalysis?.evalCp ?? null,
    currentAnalysis?.evalMate ?? null,
  );

  return (
    <div className="app">
      <header className="topbar">
        {game && (
          <button
            type="button"
            className="icon-btn"
            onClick={goBackToImport}
            aria-label="Back to import"
            title="Back to import"
          >
            <IconBack />
          </button>
        )}

        <span className="brand">
          <ChesyMark className="brand-mark" />
          <span>Chesy</span>
        </span>

        {game && (
          <div className="topbar-title">
            <span className="players muted">
              {game.headers.White ?? '?'} vs {game.headers.Black ?? '?'}
            </span>
          </div>
        )}

        <div className="topbar-actions">
          {/* The engine's identity was a permanent pill here; it is
              static information that only matters when something is
              wrong, so it now shows only in that case. */}
          {engineInfo && !engineInfo.available && (
            <span className="status-pill is-warning">
              <span className="status-dot" />
              <span className="status-label">Stockfish not detected</span>
            </span>
          )}

          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      {!game && (
        <HomeFlow
          onImport={handleImport}
          recent={recentReviews}
          onOpenRecent={(id) => void openStoredReview(id)}
        />
      )}

      {game && currentFen && (
        <main className="review">
          <section
            className="stage"
            style={{ ['--board-px' as string]: boardPx ? `${boardPx}px` : undefined }}
          >
            <div className="stage-head">
              <div className="stage-move">
                <span className="san">{moveLabel}</span>
                {currentClassification && (
                  <span className={`badge badge-${currentClassification}`}>
                    {CLASSIFICATION_LABELS[currentClassification] ?? currentClassification}
                  </span>
                )}
              </div>

              <div className="stage-tools">
                <button
                  type="button"
                  className={`chip-btn ${showArrows ? 'is-active' : ''}`}
                  onClick={() => setShowArrows(!showArrows)}
                  title="Toggle tactical arrows and motif highlights"
                >
                  <IconTarget />
                  Arrows
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={toggleOrientation}
                  title="Flip the board (hotkey: F)"
                >
                  <IconFlip />
                  {boardOrientation === 'white' ? 'White' : 'Black'}
                </button>
              </div>
            </div>

            {reviewing && reviewProgress && (
              <div className="progress">
                <div className="progress-label">
                  <span>
                    Evaluating {reviewProgress.current} of {reviewProgress.total} positions
                  </span>
                  <span className="numeric">{progressPercent}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            <div className="stage-inner">
              <BoardStage
                // While practising, the board rewinds to the position the
                // mistake was played from — that's the position being
                // drilled, not the one after it.
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
                onMeasure={setBoardPx}
                interactive={!!practice && practice.status !== 'revealed'}
                onMove={handlePracticeMove}
              />
            </div>

            <nav className="stepper" aria-label="Move navigation">
              <button
                type="button"
                className="step-btn"
                onClick={goToStart}
                disabled={!canPrevious}
                aria-label="Starting position"
              >
                <IconSkipStart />
              </button>
              <button
                type="button"
                className="step-btn"
                onClick={goToPrevious}
                disabled={!canPrevious}
                aria-label="Previous move"
              >
                <IconChevronLeft />
              </button>
              <span className="step-count">
                {currentIndex + 1} / {game.moves.length}
              </span>
              <button
                type="button"
                className="step-btn"
                onClick={goToNext}
                disabled={!canNext}
                aria-label="Next move"
              >
                <IconChevronRight />
              </button>
              <button
                type="button"
                className="step-btn"
                onClick={goToEnd}
                disabled={!canNext}
                aria-label="Final position"
              >
                <IconSkipEnd />
              </button>
            </nav>

            {review && (
              <div className={`graph-wrap${graphOpen ? '' : ' is-collapsed'}`}>
                <div className="graph-head">
                  <span className="eyebrow">Position map</span>
                  {/* The curve alone can't say which move a peak belongs
                      to. This names the move under the cursor as it is
                      scrubbed, which is what makes the shape actionable. */}
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
                  <button
                    type="button"
                    className="graph-toggle"
                    onClick={() => setGraphOpen((v) => !v)}
                    aria-expanded={graphOpen}
                    aria-label={graphOpen ? 'Hide position map' : 'Show position map'}
                    title={graphOpen ? 'Hide position map' : 'Show position map'}
                  >
                    <IconChevronRight />
                  </button>
                </div>

                {graphOpen && (
                  <GameGraph
                    moves={review.moves}
                    totalMoves={game.moves.length}
                    currentIndex={currentIndex}
                    onSelect={setCurrentIndex}
                  />
                )}
              </div>
            )}
          </section>

          <div className="side is-desktop">
            <div className="pane-tabs" role="tablist" aria-label="Review detail">
              <button
                type="button"
                role="tab"
                aria-selected={activePane === 'insight'}
                className={`pane-tab ${activePane === 'insight' ? 'is-active' : ''}`}
                onClick={() => setActivePane('insight')}
              >
                Insight
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activePane === 'moves'}
                className={`pane-tab ${activePane === 'moves' ? 'is-active' : ''}`}
                onClick={() => setActivePane('moves')}
              >
                Moves
              </button>
            </div>

            <div className={`pane pane-insight ${activePane === 'insight' ? '' : 'is-collapsed'}`}>

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
                      title="Depth 10, single line — faster, no Great/Brilliant detection. Best for weaker hardware."
                    >
                      Fast
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${reviewMode === 'deep' ? 'is-active' : ''}`}
                      onClick={() => setReviewMode('deep')}
                      disabled={reviewing}
                      title="Depth 14, two lines — full classification including Great/Brilliant. Slower."
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
                      ? `Reviewing ${progressPercent ?? 0}%`
                      : review
                        ? 'Retry review'
                        : 'Review game'}
                  </button>
                </div>
              )}

              {reviewError && <div className="notice">{reviewError}</div>}
            </div>

            <div className={`pane pane-moves ${activePane === 'moves' ? '' : 'is-collapsed'}`}>
              {review && (
                <div className="accuracy">
                  {([
                    ['White', review.whiteAccuracy],
                    ['Black', review.blackAccuracy],
                  ] as const).map(([side, value]) => (
                    <div className="accuracy-cell" key={side}>
                      <span className="eyebrow">{side}{!isReviewComplete ? ' so far' : ''}</span>
                      <span className="accuracy-value">{value.toFixed(1)}%</span>
                      {/* The bar is the colour: a bare percentage gives no
                          sense of whether 78% is good, and the band it falls
                          in is exactly what the classification ramp encodes. */}
                      <span className="accuracy-bar">
                        <span
                          className={`accuracy-fill accuracy-${accuracyBand(value)}`}
                          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <MoveList moves={displayMoves} currentIndex={currentIndex} onSelect={setCurrentIndex} />
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
