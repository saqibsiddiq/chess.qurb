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
  ChesyMark,
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
  const tr = useT();
  const [game, setGame] = useState<ParsedGame | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1); // -1 = starting position

  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[] | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ current: number; total: number } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>(() => loadSettings().depth);
  /** Which secondary reading is open over the review, if any. These
   *  used to be a permanent strip of the layout, which is what left
   *  the board at 130px on a phone. */
  const [extra, setExtra] = useState<'graph' | 'time' | null>(null);
  /** The step HomeFlow is on, lifted up so the app has exactly one top
   *  bar. `onBack` null means the first screen — the only place the logo
   *  and the theme control appear. */
  const [homeNav, setHomeNav] = useState<{
    title: string;
    onBack: (() => void) | null;
    onTitleTap?: (() => void) | null;
  }>({ title: '', onBack: null });
  /** Open state of the account menu hanging off the title. */
  const [accountMenu, setAccountMenu] = useState(false);

  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  // "System" is a live choice, not a one-off reading: the OS can change
  // theme under a running app, and following it means following it.
  useEffect(() => {
    if (settings.theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applySettings(settings);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [settings]);
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
  // Where the current review's numbers came from. Worth surfacing: an
  // imported analysis is a different depth, and can't produce Great or
  // Brilliant, so presenting it as identical to a local run would be
  // quietly misleading.
  const [reviewSource, setReviewSource] = useState<'engine' | 'lichess'>('engine');

  // What the app still has to fetch before it can review anything. On
  // every run after the first this resolves to "nothing missing" and the
  // gate below never appears.
  const assets = useAssets();

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

  const handleImport = (pgn: string, analysis?: LichessAnalysisEntry[]) => {
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
      setCurrentIndex(-1);
      setReviewProgress(null);
      setReviewError(null);
      setSlmExplanations({});

      if (hasUsableAnalysis(analysis, parsed)) {
        // The source already analysed this game, so the whole review can
        // be rendered from data that arrived with the download — no
        // engine, no wait, no battery. Marking it auto-reviewed before
        // the state update is what stops the auto-review effect from
        // launching Stockfish over a game that is already done.
        const imported = toAnalysisResults(analysis!, parsed);
        const built = reviewGame(parsed, imported);
        autoReviewedGame.current = parsed;
        setGame(parsed);
        setAnalysisResults(imported);
        setReview(built);
        setReviewSource('lichess');

        // Saved on the same terms as an engine review, so an imported
        // game still appears in the library and still feeds the
        // cross-game weakness stats.
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
    setReviewSource('engine');

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

  // Seconds each move actually took, derived from the clock readings the
  // PGN already carried and previously threw away.
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

  // Named from the PGN's own headers; the book-exit ply comes from
  // Chesy's mined book, which answers a different question — where the
  // player stopped following moves other players actually play.
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

  /** Whether this game carried clock annotations at all. Games from a
   *  PGN without `%clk` have none, and an empty panel behind an
   *  enabled button is worse than no button. */
  const hasClockData = !!clockSummary && !!(clockSummary.white || clockSummary.black);

  /** The one screen that shows the logo and the theme control. */
  const atHome = !game && !showSettings && homeNav.onBack === null;

  const evalPercent = evalToPercent(
    currentAnalysis?.evalCp ?? null,
    currentAnalysis?.evalMate ?? null,
  );

  return (
    <div className="app">
      {/* The website's chess field, behind the whole shell. It only
          animates on the menu screens: once a game is open Stockfish is
          searching and the board has to stay smooth, so the field is
          painted once and left alone. */}
      {/* The user can turn the drift off outright — it is the one piece
          of decoration that never stops, and it is also what every glass
          surface is paying to blur. */}
      <PieceField
        mode={settings.motion === 'static' || game ? 'static' : 'live'}
        theme={resolveTheme(settings.theme)}
      />

      <header className={`topbar${atHome ? '' : ' glass'}`}>
        {/* One bar for the whole app. The logo and the theme control are
            the first screen's alone; every other screen gets a back
            button in that corner instead, so the way out is always in the
            same place. */}
        {atHome ? (
          <span className="brand">
            <ChesyMark className="brand-mark" />
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
            /* The title names the connected account, so it is also where
               you change it — no row anywhere else on the screen, which
               is what leaves the whole page for the games. */
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
              {/* Anchored under the name it acts on. Centring it on the
                  viewport left it sitting off to one side of a title that
                  is not itself centred. */}
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
          {/* Board chrome, not board content. These sat in a row above the
              board and were the elements that overflowed it on a phone —
              a 160px toolbar inside a 130px column. */}
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

          {/* Static information that only matters when something is
              wrong, so it shows only in that case. */}
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

      {/* Nothing else is reachable until the engine has what it needs —
          every screen here leads to a review, and a review without the
          networks would fail at the last step instead of the first. The
          settings screen stays open, so the language can still be
          changed while waiting. */}
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
          {/* Insight first. The explanation is what this screen exists to
              deliver, so on a phone it sits above the board where it can be
              read without moving anything. The board follows it, and
              navigation lives on the board itself. */}
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
              interactive={!!practice && practice.status !== 'revealed'}
              onMove={handlePracticeMove}
            />
          </section>

          {/* Where you are in the game. The board already steps and jumps
              on tap, so this carries position rather than controls. */}
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

          {/* Tablet and desktop have room to show, permanently, what the
              phone puts behind those buttons. Same components, different
              parent — nothing here is a second implementation. */}
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
                {/* Stated plainly rather than passed off as a local run: an
                    imported analysis is a different depth and carries no
                    runner-up line, so it cannot produce Great or Brilliant. */}
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

              {/* Scrolls sideways rather than squeezing a 90-move game
                  into 328px. Below about 14px per move the markers stop
                  being separable, let alone tappable. */}
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

              {/* The turning points belong with the curve — each one is a
                  place it swings — and putting them here is also what
                  keeps them reachable on a phone, where the detail column
                  does not exist. Tapping one jumps the board to it. */}
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
                          {/* Win probability, not centipawns: it is what
                              makes two moments comparable. */}
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
                      {/* The number that matters: mistakes made while
                          rushing are a different problem from mistakes
                          made after a long think. */}
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
                    {timeSpent[currentIndex]! < RUSHED_SECONDS && ' — played almost instantly.'}
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
