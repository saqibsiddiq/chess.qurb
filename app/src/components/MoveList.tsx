import { useEffect, useRef } from 'react';
import type { ParsedMove } from '../lib/parsePgn';
import type { Classification } from '../lib/reviewEngine.ts';

type MoveListItem = ParsedMove & { classification?: Classification };

interface MoveListProps {
  moves: MoveListItem[];
  currentIndex: number; // -1 means the starting position
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

export default function MoveList({ moves, currentIndex, onSelect }: MoveListProps) {
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Group moves by turn
  const turns: TurnRow[] = [];
  let currentTurn: TurnRow | null = null;

  moves.forEach((move, index) => {
    if (move.color === 'w') {
      currentTurn = {
        moveNumber: move.moveNumber,
        whiteMove: move,
        whiteIndex: index,
      };
      turns.push(currentTurn);
    } else {
      if (!currentTurn || currentTurn.moveNumber !== move.moveNumber || currentTurn.blackMove) {
        currentTurn = {
          moveNumber: move.moveNumber,
          blackMove: move,
          blackIndex: index,
        };
        turns.push(currentTurn);
      } else {
        currentTurn.blackMove = move;
        currentTurn.blackIndex = index;
      }
    }
  });

  // Smoothly scroll active move into view
  useEffect(() => {
    if (activeBtnRef.current) {
      activeBtnRef.current.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [currentIndex]);

  return (
    <div className="move-list-container">
      <div className="move-list">
        {turns.map((turn) => (
          <div key={turn.moveNumber} className="turn-row">
            <span className="turn-number">{turn.moveNumber}.</span>
            {turn.whiteMove && turn.whiteIndex !== undefined ? (
              <button
                type="button"
                ref={turn.whiteIndex === currentIndex ? activeBtnRef : null}
                className={`move-item ${turn.whiteIndex === currentIndex ? 'active' : ''} ${
                  turn.whiteMove.classification ? `move-${turn.whiteMove.classification}` : ''
                }`}
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
              <div className="move-item empty" />
            )}

            {turn.blackMove && turn.blackIndex !== undefined ? (
              <button
                type="button"
                ref={turn.blackIndex === currentIndex ? activeBtnRef : null}
                className={`move-item ${turn.blackIndex === currentIndex ? 'active' : ''} ${
                  turn.blackMove.classification ? `move-${turn.blackMove.classification}` : ''
                }`}
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
              <div className="move-item empty" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}