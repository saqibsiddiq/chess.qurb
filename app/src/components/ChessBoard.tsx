import { useCallback, useEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chess.js';
import type { BoardShape } from '../lib/explanations';
import type { Key } from '@lichess-org/chessground/types';

// Chessground stylesheets
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
// cburnett, chessground's default set — chosen for how it looks beside
// the rest of the app. Worth knowing it is GPLv2+ (see Lichess's
// COPYING.md), so shipping it carries that licence's obligations even
// though the rest of this app is MIT. The CC0 alternative that avoids
// them is kept at ../assets/chessground.rhosgfx.css.
import '@lichess-org/chessground/assets/chessground.cburnett.css';

interface ChessBoardProps {
  fen: string;
  shapes?: BoardShape[];
  orientation?: 'white' | 'black';
  /// Practice mode: unlocks the board so the side to move can play a
  /// move, instead of the read-only board used for reviewing.
  interactive?: boolean;
  onMove?: (from: string, to: string, promotion?: string) => void;
  /**
   * Hands out Chessground's imperative API once the board exists. Used to
   * drive the board from tests/harnesses, since Chessground ignores
   * synthetic pointer events (it checks `isTrusted`) and so a drag can't
   * be simulated from script.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onApiReady?: (api: any) => void;
}

/// Legal destinations per origin square, in the shape Chessground wants.
/// Derived here rather than passed in so callers only have to say
/// "interactive" — the position already fully determines this.
function legalDests(fen: string): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  try {
    const chess = new Chess(fen);
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      dests.set(from, [...(dests.get(from) ?? []), move.to as Key]);
    }
  } catch {
    // An unparseable FEN just means no legal moves to offer.
  }
  return dests;
}

function turnColor(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export default function ChessBoard({
  fen,
  shapes = [],
  orientation = 'white',
  interactive = false,
  onMove,
  onApiReady,
}: ChessBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiRef = useRef<any>(null);
  const lastStateRef = useRef<string>('');
  // Chessground is constructed once, so its move callback would otherwise
  // capture whichever `onMove` existed at mount and never see a newer one.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onApiReadyRef = useRef(onApiReady);
  onApiReadyRef.current = onApiReady;
  // Rebuilt on every render so it always closes over the current props.
  const restoreRef = useRef<(() => void) | null>(null);

  // Built exactly once, and never with `viewOnly`.
  //
  // Chessground's `bindBoard` returns early when `viewOnly` is set (see
  // its events.ts) and only runs at construction, so a board built
  // read-only has no pointer handlers and toggling the flag later can
  // never add them — that was why practice pieces wouldn't move.
  // Rebuilding the board when the mode flips fixed it but made entering
  // a drill visibly flash. Interactivity is instead governed by
  // `movable.color`: Chessground's `isMovable` requires it to match the
  // piece's colour, so leaving it undefined makes every piece inert
  // while the handlers stay bound. No rebuild, no flash.
  useEffect(() => {
    if (!containerRef.current) return;
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      viewOnly: false,
      coordinates: true,
      // Pieces slide between positions rather than cutting. Short enough
      // that holding an arrow key still feels responsive.
      animation: { enabled: true, duration: 180 },
      turnColor: turnColor(fen),
      movable: {
        free: false,
        showDests: true,
        color: interactive ? turnColor(fen) : undefined,
        dests: interactive ? legalDests(fen) : new Map(),
        events: {
          after: (orig: Key, dest: Key) => {
            // Chessground reports the squares only. Promotion is resolved
            // by the caller, which owns the position — auto-queening is
            // the right default and anything else needs a picker UI.
            onMoveRef.current?.(orig, dest);

            // Then put the drill position back. Chessground has just
            // mutated its own board, but the prop still describes the
            // position being practised, so nothing in React re-syncs it —
            // leaving the board one move ahead with no legal destinations
            // and no way to attempt again. Deferred by a frame so this
            // doesn't re-enter Chessground from inside its own callback.
            const restore = restoreRef.current;
            if (restore) requestAnimationFrame(restore);
          },
        },
      },
      drawable: {
        enabled: true,
        visible: true,
        shapes: shapes.map((s) => ({
          orig: s.orig as Key,
          dest: s.dest as Key | undefined,
          brush: s.brush,
        })),
      },
    });
    // Forces the sync effect below to re-apply, since a rebuilt board
    // starts with no memory of what was last pushed to it.
    lastStateRef.current = '';
    onApiReadyRef.current?.(apiRef.current);

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One place that pushes the desired position onto the board, shared by
  // the prop-sync effect and by the post-move restore.
  const applyPosition = useCallback(() => {
    if (!apiRef.current) return;
    const color = turnColor(fen);
    apiRef.current.set({
      fen,
      orientation,
      turnColor: color,
      // Explicitly present-but-empty so Chessground clears it (its
      // config.ts only resets `lastMove` when the key is supplied). A
      // practice attempt highlights its own from/to squares, and without
      // this those stayed lit long after the drill ended — including
      // after navigating to an entirely different move.
      lastMove: undefined,
      movable: {
        free: false,
        // Only the side whose turn it is may move, and only to squares
        // the rules actually allow — practice should not let someone
        // "solve" a position with an illegal move. Leaving `color`
        // undefined is what makes the board inert outside a drill.
        color: interactive ? color : undefined,
        dests: interactive ? legalDests(fen) : new Map(),
        showDests: true,
      },
      drawable: {
        shapes: shapes.map((s) => ({
          orig: s.orig as Key,
          dest: s.dest as Key | undefined,
          brush: s.brush,
        })),
      },
    });
  }, [fen, orientation, interactive, shapes]);

  restoreRef.current = applyPosition;

  useEffect(() => {
    if (!apiRef.current) return;
    const nextState = JSON.stringify({ fen, orientation, shapes, interactive });
    // The board can also drift without any prop changing — the user moves
    // a piece during a drill — so the board's real placement is checked
    // too, not just the props that describe it.
    const drifted = apiRef.current.getFen() !== fen.split(' ')[0];
    if (nextState === lastStateRef.current && !drifted) return;
    lastStateRef.current = nextState;
    applyPosition();
  }, [fen, shapes, orientation, interactive, applyPosition]);

  return <div ref={containerRef} className="board-container" />;
}
