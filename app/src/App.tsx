import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import ChessBoard from './components/ChessBoard';
import PgnImporter from './components/PgnImporter';
import MoveList from './components/MoveList';
import EnginePanel from './components/EnginePanel';
import GameGraph from './components/GameGraph.tsx';
import { parsePgn, type ParsedGame } from './lib/parsePgn';
import { reviewGame, type GameReview } from './lib/reviewEngine.ts';
import type { AnalysisResult, EngineInfo, ReviewProgressPayload } from './lib/analysis.ts';
import type { BoardShape } from './lib/explanations.ts';
import './App.css';

const REVIEW_DEPTH = 14;

function App() {
  const [game, setGame] = useState<ParsedGame | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1); // -1 = starting position

  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[] | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ current: number; total: number } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [showArrows, setShowArrows] = useState(true);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  const autoReviewedGame = useRef<ParsedGame | null>(null);
  const reviewRequest = useRef(0);

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
    try {
      reviewRequest.current += 1;
      const parsed = parsePgn(pgn);
      setGame(parsed);
      setCurrentIndex(-1);
      setAnalysisResults(null);
      setReview(null);
      setReviewProgress(null);
      setReviewError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Could not parse that PGN: ${message}`);
      console.error(err);
    }
  };

  const runReview = async (gameToReview: ParsedGame) => {
    const requestId = ++reviewRequest.current;
    setReviewing(true);
    setReviewProgress({ current: 0, total: gameToReview.moves.length + 1 });
    setReviewError(null);

    let unlisten: (() => void) | null = null;
    try {
      const fens = [gameToReview.startingFen, ...gameToReview.moves.map((m) => m.fenAfter)];

      unlisten = await listen<ReviewProgressPayload>('review-progress', (event) => {
        if (requestId !== reviewRequest.current) return;
        const { index, total, result } = event.payload;
        setReviewProgress({ current: index + 1, total });
        setAnalysisResults((prev) => {
          const updated = prev ? [...prev] : new Array(total).fill(null);
          updated[index] = result;
          return updated;
        });
      });

      const results = await invoke<AnalysisResult[]>('analyze_game', {
        fens,
        depth: REVIEW_DEPTH,
        enginePath: null,
      });

      if (requestId !== reviewRequest.current) return;
      setAnalysisResults(results);
      setReview(reviewGame(gameToReview, results));
    } catch (err) {
      if (requestId === reviewRequest.current) setReviewError(String(err));
    } finally {
      if (unlisten) unlisten();
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

  useEffect(() => {
    if (!game || autoReviewedGame.current === game) return;
    autoReviewedGame.current = game;
    const reviewTimer = window.setTimeout(() => {
      void runReview(game);
    }, 120);
    return () => window.clearTimeout(reviewTimer);
  }, [game]);

  const goToStart = () => setCurrentIndex(-1);
  const goToEnd = () => game && setCurrentIndex(game.moves.length - 1);
  const goToPrevious = () => setCurrentIndex((i) => Math.max(-1, i - 1));
  const goToNext = () =>
    setCurrentIndex((i) => (game ? Math.min(game.moves.length - 1, i + 1) : i));

  const goBackToImport = () => {
    reviewRequest.current += 1;
    setGame(null);
    setCurrentIndex(-1);
    setAnalysisResults(null);
    setReview(null);
    setReviewProgress(null);
    setReviewError(null);
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
  const currentClassification =
    review && currentIndex >= 0 ? review.moves[currentIndex].classification : undefined;
  const currentExplanation =
    review && currentIndex >= 0 ? review.moves[currentIndex].explanation : undefined;

  // Memoized active board shapes
  const currentShapes = useMemo<BoardShape[]>(() => {
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
  }, [showArrows, currentExplanation?.shapes, currentAnalysis?.bestMove]);

  const progressPercent = reviewProgress
    ? Math.round((reviewProgress.current / reviewProgress.total) * 100)
    : null;

  return (
    <div className="app">
      <header className="topbar">
        {game && (
          <button className="back-button" aria-label="Back to import" title="Back to import" onClick={goBackToImport}>
            ←
          </button>
        )}
        <div className="brand-mark">C</div>
        <div className="brand-copy">
          <span className="eyebrow">Chess analysis studio</span>
          <h1>ChessReview</h1>
        </div>

        <div className="topbar-actions">
          {engineInfo && (
            <div className={`status-pill ${engineInfo.available ? 'status-ready' : 'status-warning'}`}>
              <span className={`status-dot ${engineInfo.available ? 'dot-green' : 'dot-red'}`} />
              {engineInfo.available ? engineInfo.name || 'Stockfish Ready' : 'Stockfish not detected'}
            </div>
          )}
        </div>
      </header>

      {!game && (
        <section className="welcome-panel">
          <div className="welcome-copy">
            <span className="eyebrow">Your board, your pace</span>
            <h2>See the game<br /><em>one move at a time.</em></h2>
            <p>Import a PGN to revisit key moments, study the flow, and find the tactical and positional ideas that shaped the game.</p>
          </div>
          <PgnImporter onImport={handleImport} />
        </section>
      )}

      {game && currentFen && (
        <main className="review-layout">
          <section className="board-column">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Current position</span>
                <h2>{currentIndex === -1 ? 'Starting position' : `Move ${game.moves[currentIndex].moveNumber}${game.moves[currentIndex].color === 'w' ? '.' : '...' } ${game.moves[currentIndex].san}`}</h2>
              </div>
              <div className="board-controls">
                <button
                  type="button"
                  className={`tool-btn ${showArrows ? 'active' : ''}`}
                  onClick={() => setShowArrows(!showArrows)}
                  title="Toggle tactical arrows and motif highlights"
                >
                  🎯 Arrows: {showArrows ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  onClick={toggleOrientation}
                  title="Flip board orientation (hotkey: F)"
                >
                  🔄 {boardOrientation === 'white' ? 'White' : 'Black'}
                </button>
                <span className="move-counter">{currentIndex + 1} / {game.moves.length}</span>
              </div>
            </div>

            {reviewing && reviewProgress && (
              <div className="review-progress-bar-container">
                <div className="review-progress-label">
                  <span>Engine evaluating game ({reviewProgress.current} / {reviewProgress.total} positions)</span>
                  <strong>{progressPercent}%</strong>
                </div>
                <div className="review-progress-track">
                  <div className="review-progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            <div className="board-frame">
              <ChessBoard
                fen={currentFen}
                shapes={currentShapes}
                orientation={boardOrientation}
              />
            </div>

            {review && (
              <section className="position-map">
                <div className="map-heading">
                  <div>
                    <span className="eyebrow">Position map</span>
                    <strong>{currentIndex < 0 ? 'Opening position' : `After ${game.moves[currentIndex].moveNumber}${game.moves[currentIndex].color === 'w' ? '.' : '...' } ${game.moves[currentIndex].san}`}</strong>
                  </div>
                  <span>{currentIndex + 1} / {game.moves.length}</span>
                </div>
                <GameGraph moves={review.moves} currentIndex={currentIndex} onSelect={setCurrentIndex} />
                <div className="map-labels">
                  <span>Start</span>
                  <span>Evaluation across the game</span>
                  <span>Finish</span>
                </div>
              </section>
            )}
          </section>

          <div className="side-panel">
            <div className="headers">
              {game.headers.White ?? '?'} vs {game.headers.Black ?? '?'}
            </div>

            <EnginePanel
              fen={currentFen}
              analysis={currentAnalysis}
              classification={currentClassification}
              explanation={currentExplanation}
              loading={reviewing}
              progressPercent={progressPercent}
            />

            {!review && (
              <button className="review-button" onClick={handleReview} disabled={reviewing}>
                {reviewing ? `Reviewing (${progressPercent ?? 0}%)…` : 'Review Game'}
              </button>
            )}
            {reviewError && <div className="engine-error">Review notice: {reviewError}</div>}

            {review && (
              <div className="accuracy-header">
                <div>White accuracy: {review.whiteAccuracy.toFixed(1)}%</div>
                <div>Black accuracy: {review.blackAccuracy.toFixed(1)}%</div>
              </div>
            )}

            <MoveList
              moves={review ? review.moves : game.moves}
              currentIndex={currentIndex}
              onSelect={setCurrentIndex}
            />

            <div className="nav-buttons">
              <button onClick={goToStart} disabled={currentIndex === -1} title="First move">
                ⏮ Start
              </button>
              <button onClick={goToPrevious} disabled={currentIndex === -1} title="Previous move (Left arrow)">
                ◀ Prev
              </button>
              <button
                onClick={goToNext}
                disabled={currentIndex === game.moves.length - 1}
                title="Next move (Right arrow)"
              >
                Next ▶
              </button>
              <button
                onClick={goToEnd}
                disabled={currentIndex === game.moves.length - 1}
                title="Final position"
              >
                End ⏭
              </button>
            </div>
          </div>
        </main>
      )}
      {!game && <div className="footer-note"><span>01</span> Import a game to begin your review</div>}
    </div>
  );
}

export default App;
