import { useEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { BoardShape } from '../lib/explanations';
import type { Key } from '@lichess-org/chessground/types';

// Chessground stylesheets
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

interface ChessBoardProps {
  fen: string;
  shapes?: BoardShape[];
  orientation?: 'white' | 'black';
}

export default function ChessBoard({ fen, shapes = [], orientation = 'white' }: ChessBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiRef = useRef<any>(null);
  const lastStateRef = useRef<string>('');

  useEffect(() => {
    if (!containerRef.current) return;
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      viewOnly: true,
      coordinates: true,
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
    lastStateRef.current = JSON.stringify({ fen, orientation, shapes });

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!apiRef.current) return;
    const nextState = JSON.stringify({ fen, orientation, shapes });
    if (nextState === lastStateRef.current) return;
    lastStateRef.current = nextState;

    apiRef.current.set({
      fen,
      orientation,
      drawable: {
        shapes: shapes.map((s) => ({
          orig: s.orig as Key,
          dest: s.dest as Key | undefined,
          brush: s.brush,
        })),
      },
    });
  }, [fen, shapes, orientation]);

  return <div ref={containerRef} className="board-container" />;
}
