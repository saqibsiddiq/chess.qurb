// TEMPORARY harness — mounted only when the dev server is loaded with
// ?harness=practice. Lets the practice board be driven in a plain browser
// (no Tauri runtime), which is the only way to verify that pieces can
// actually be moved. Delete once verified.
import { useState } from 'react';
import ChessBoard from './components/ChessBoard';
import HomeFlow from './components/HomeFlow';
import PieceField from './components/PieceField';
import EnginePanel from './components/EnginePanel';
import { applyAttempt, type PracticeAttempt } from './lib/practice';
import type { ReviewSummary } from './lib/storage';

const FEN_BEFORE = '2r3k1/pp3pp1/4p2p/4Pn2/8/P4N2/1P1r1PPP/3R2K1 w - - 0 23';

/// Fake library so the cross-game insights panel can be seen without a
/// Tauri runtime (storage commands are unavailable in a plain browser).
const FAKE_RECENT: ReviewSummary[] = [
  ['saqibsiddiq', 'opponent_one', '1-0', 74, 61],
  ['rival_two', 'saqibsiddiq', '1-0', 68, 55],
  ['saqibsiddiq', 'a_very_long_opponent_username_here', '1/2-1/2', 81, 79],
  ['third_rival', 'saqibsiddiq', '0-1', 58, 72],
].map(([white, black, result, wAcc, bAcc], i) => ({
  id: `fake-${i}`,
  savedAt: Date.now() - i * 86400000,
  white: white as string,
  black: black as string,
  result: result as string,
  date: '2026.09.01',
  moveCount: 40 + i * 7,
  whiteAccuracy: wAcc as number,
  blackAccuracy: bAcc as number,
  whiteCounts: { blunder: 2, mistake: 1, inaccuracy: 3 },
  blackCounts: { blunder: 1, mistake: 2, inaccuracy: 2 },
  whiteMotifs: { hanging_piece: 2, fork: 1, mate: 1 },
  blackMotifs: { hanging_piece: 1, allowed_mate: 1, back_rank: 1 },
  opening: i % 2 === 0 ? 'Sicilian Defense' : 'French Defense',
  eco: i % 2 === 0 ? 'B20' : 'C00',
  bookExitPly: 6 + i,
  termination: i === 1 ? 'timeout' : 'resignation',
}));

export default function PracticeHarness() {
  // An in-page switch rather than a query param: the preview browser
  // strips query strings on navigate, so a param-driven view can't be
  // reached from tooling.
  const [view, setView] = useState<'practice' | 'home'>('practice');
  // The review screen runs the field in `static` mode; this switch is the
  // only way to exercise that path outside the Tauri runtime.
  const [fieldMode, setFieldMode] = useState<'live' | 'static'>('live');
  return (
    <>
      {/* Fixed, so it never steals height from the `.app` shell below —
          the home view has to be measured against a true 100dvh or any
          overflow finding is an artifact of this toolbar. */}
      <div
        style={{
          position: 'fixed', top: 0, left: 0, zIndex: 9999,
          padding: '2px 6px', display: 'flex', gap: 8, fontSize: 11,
          background: 'rgba(0,0,0,.6)', color: '#fff',
        }}
      >
        <button id="view-practice" onClick={() => setView('practice')}>practice</button>
        <button id="view-home" onClick={() => setView('home')}>home</button>
        <button id="field-mode" onClick={() => setFieldMode((m) => (m === 'live' ? 'static' : 'live'))}>
          field: {fieldMode}
        </button>
        <span>view: {view}</span>
      </div>
      {view === 'home' ? (
        <div className="app">
          <PieceField
            mode={fieldMode}
            theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
          />
          {/* The real shell puts `.home` in the second grid row, under the
              top bar. Without that row the panel sizes to its content and
              overflows the viewport unscrollably, which is a property of
              this harness rather than of the app. */}
          <header className="topbar">
            <span className="brand"><span>Chesy</span></span>
          </header>
          <HomeFlow onImport={() => {}} recent={FAKE_RECENT} onOpenRecent={() => {}} />
        </div>
      ) : (
        <PracticeBoardHarness />
      )}
    </>
  );
}

function PracticeBoardHarness() {
  const [interactive, setInteractive] = useState(true);
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([]);
  const [log, setLog] = useState<string[]>([]);

  // Exposed so the browser console can drive real user-moves:
  // selectSquare -> userMove -> movable.events.after, the same path a
  // human click takes. Synthetic pointer events can't be used because
  // Chessground rejects anything with isTrusted === false.
  const onApiReady = (api: unknown) => {
    (window as unknown as Record<string, unknown>).__cg = api;
  };

  const onMove = (from: string, to: string) => {
    const applied = applyAttempt(FEN_BEFORE, from, to);
    setLog((l) => [...l, `onMove ${from}->${to} ${applied ? `san=${applied.san}` : 'ILLEGAL'}`]);
    if (applied) {
      setAttempts((a) => [
        ...a,
        { ...applied, verdict: 'inaccurate', lossCp: 140, isEngineMove: false },
      ]);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 340px', gap: 24, padding: 24 }}>
      <div>
        <div style={{ width: 400 }}>
          <ChessBoard
            fen={FEN_BEFORE}
            orientation="white"
            interactive={interactive}
            onMove={onMove}
            onApiReady={onApiReady}
          />
        </div>
        <button onClick={() => setInteractive((v) => !v)} style={{ marginTop: 12 }}>
          interactive: {String(interactive)} (toggle)
        </button>
        <pre id="harness-log" style={{ fontSize: 12, marginTop: 12 }}>{log.join('\n') || '(no moves yet)'}</pre>
      </div>
      <div className="pane pane-insight">
        <EnginePanel
          fen={FEN_BEFORE}
          analysis={null}
          practice={{ attempts, status: 'awaiting' }}
          canPractice
          practiceBestSan="Nxd2"
          onStartPractice={() => {}}
          onRevealPractice={() => {}}
          onExitPractice={() => setAttempts([])}
        />
      </div>
    </div>
  );
}
