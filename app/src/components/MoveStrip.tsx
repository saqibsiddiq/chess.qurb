import { memo, useEffect, useRef } from 'react';
import type { ParsedMove } from '../lib/parsePgn';
import type { Classification } from '../lib/reviewEngine.ts';

type MoveStripItem = ParsedMove & { classification?: Classification };

interface MoveStripProps {
  moves: MoveStripItem[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

function MoveStrip({ moves, currentIndex, onSelect }: MoveStripProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const active = activeRef.current;
    if (!rail || !active) return;

    const target =
      active.offsetLeft - rail.clientWidth / 2 + active.offsetWidth / 2;
    const max = rail.scrollWidth - rail.clientWidth;
    const left = Math.max(0, Math.min(target, max));

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' });
  }, [currentIndex, moves.length]);

  if (moves.length === 0) return null;

  return (
    <div className="move-strip" ref={railRef}>
      <button
        type="button"
        className={`strip-item is-start${currentIndex < 0 ? ' is-current' : ''}`}
        ref={currentIndex < 0 ? activeRef : undefined}
        onClick={() => onSelect(-1)}
        aria-current={currentIndex < 0}
      >
        Start
      </button>

      {moves.map((move, index) => {
        const current = index === currentIndex;
        return (
          <button
            key={index}
            type="button"
            className={`strip-item${current ? ' is-current' : ''}`}
            ref={current ? activeRef : undefined}
            onClick={() => onSelect(index)}
            aria-current={current}
          >
            {}
            {move.color === 'w' && <span className="strip-no num">{move.moveNumber}.</span>}
            {}
            <span className={`strip-san${move.classification ? ` c-${move.classification}` : ''}`}>
              {move.san}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default memo(MoveStrip);
