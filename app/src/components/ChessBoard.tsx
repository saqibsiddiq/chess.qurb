import { useCallback, useEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chess.js';
import type { BoardShape } from '../lib/explanations';
import type { Key } from '@lichess-org/chessground/types';

import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
// cburnett, chessground's default set, chosen for how it looks beside
// the rest of the app. Worth knowing it is GPLv2+ (see Lichess's
// COPYING.md), so shipping it carries that licence's obligations even
// though the rest of this app is MIT. The CC0 alternative that avoids
// them is kept at ../assets/chessground.rhosgfx.css.
import '@lichess-org/chessground/assets/chessground.cburnett.css';

interface ChessBoardProps {
  fen: string;
  shapes?: BoardShape[];
  orientation?: 'white' | 'black';
  interactive?: boolean;
  onMove?: (from: string, to: string, promotion?: string) => void;
  onApiReady?: (api: any) => void;
}

function legalDests(fen: string): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  try {
    const chess = new Chess(fen);
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      dests.set(from, [...(dests.get(from) ?? []), move.to as Key]);
    }
  } catch {
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
  const apiRef = useRef<any>(null);
  const lastStateRef = useRef<string>('');
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onApiReadyRef = useRef(onApiReady);
  onApiReadyRef.current = onApiReady;
  const restoreRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      viewOnly: false,
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      turnColor: turnColor(fen),
      movable: {
        free: false,
        showDests: true,
        color: interactive ? turnColor(fen) : undefined,
        dests: interactive ? legalDests(fen) : new Map(),
        events: {
          after: (orig: Key, dest: Key) => {
            onMoveRef.current?.(orig, dest);

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
    lastStateRef.current = '';
    onApiReadyRef.current?.(apiRef.current);

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, []);

  const applyPosition = useCallback(() => {
    if (!apiRef.current) return;
    const color = turnColor(fen);
    apiRef.current.set({
      fen,
      orientation,
      turnColor: color,
      lastMove: undefined,
      movable: {
        free: false,
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
    const drifted = apiRef.current.getFen() !== fen.split(' ')[0];
    if (nextState === lastStateRef.current && !drifted) return;
    lastStateRef.current = nextState;
    applyPosition();
  }, [fen, shapes, orientation, interactive, applyPosition]);

  return <div ref={containerRef} className="board-container" />;
}
