import { memo, useEffect, useMemo, useRef } from 'react';
import type { ParsedMove } from '../lib/parsePgn';
import type { Classification } from '../lib/reviewEngine.ts';

type MoveListItem = ParsedMove & { classification?: Classification };

interface MoveListProps {
  moves: MoveListItem[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

const SYMBOLS: Partial<Record<Classification, string>> = {
  brilliant: '!!',
  great: '!',
  best: '★',
  inaccuracy: '?!',
  miss: '⚑',
  mistake: '?',
  blunder: '??',
};

interface TurnRow {
  moveNumber: number;
  whiteMove?: MoveListItem;
  whiteIndex?: number;
  blackMove?: MoveListItem;
  blackIndex?: number;
}

function MoveList({ moves, currentIndex, onSelect }: MoveListProps) {
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  const turns = useMemo(() => {
    const rows: TurnRow[] = [];
    let currentTurn: TurnRow | null = null;

    moves.forEach((move, index) => {
      if (move.color === 'w') {
        currentTurn = {
          moveNumber: move.moveNumber,
          whiteMove: move,
          whiteIndex: index,
        };
        rows.push(currentTurn);
      } else {
        if (!currentTurn || currentTurn.moveNumber !== move.moveNumber || currentTurn.blackMove) {
          currentTurn = {
            moveNumber: move.moveNumber,
            blackMove: move,
            blackIndex: index,
          };
          rows.push(currentTurn);
        } else {
          currentTurn.blackMove = move;
          currentTurn.blackIndex = index;
        }
      }
    });
    return rows;
  }, [moves]);

  useEffect(() => {
    if (!activeBtnRef.current) return;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    activeBtnRef.current.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, [currentIndex]);

  return (
    <div className="move-list">
      <div>
        {turns.map((turn) => (
          <div key={turn.moveNumber} className="turn-row">
            <span className="turn-number">{turn.moveNumber}.</span>
            {turn.whiteMove && turn.whiteIndex !== undefined ? (
              <button
                type="button"
                ref={turn.whiteIndex === currentIndex ? activeBtnRef : null}
                className={`move-item ${turn.whiteIndex === currentIndex ? 'is-active' : ''}`}
                onClick={() => onSelect(turn.whiteIndex!)}
              >
                <span className="san">{turn.whiteMove.san}</span>
                {turn.whiteMove.classification && SYMBOLS[turn.whiteMove.classification] && (
                  <span className={`glyph glyph-${turn.whiteMove.classification}`}>
                    {SYMBOLS[turn.whiteMove.classification]}
                  </span>
                )}
              </button>
            ) : (
              <div className="move-item is-empty" />
            )}

            {turn.blackMove && turn.blackIndex !== undefined ? (
              <button
                type="button"
                ref={turn.blackIndex === currentIndex ? activeBtnRef : null}
                className={`move-item ${turn.blackIndex === currentIndex ? 'is-active' : ''}`}
                onClick={() => onSelect(turn.blackIndex!)}
              >
                <span className="san">{turn.blackMove.san}</span>
                {turn.blackMove.classification && SYMBOLS[turn.blackMove.classification] && (
                  <span className={`glyph glyph-${turn.blackMove.classification}`}>
                    {SYMBOLS[turn.blackMove.classification]}
                  </span>
                )}
              </button>
            ) : (
              <div className="move-item is-empty" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(MoveList);
