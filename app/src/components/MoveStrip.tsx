import { memo, useEffect, useRef } from 'react';
import type { ParsedMove } from '../lib/parsePgn';
import type { Classification } from '../lib/reviewEngine.ts';

type MoveStripItem = ParsedMove & { classification?: Classification };

interface MoveStripProps {
  moves: MoveStripItem[];
  /** -1 means the starting position. */
  currentIndex: number;
  onSelect: (index: number) => void;
}

/**
 * The whole game as one horizontal, self-scrolling strip.
 *
 * This is the phone's replacement for both the stepper and the vertical
 * move list. The board already carries navigation — tap either side to
 * step, double-tap to jump to the end — so a row of arrow buttons under
 * it spends 44px of a 780px screen on something the board does better.
 * What the board cannot show is *where you are in the game*, and that is
 * this strip's job: it keeps the current move centred as you step, so the
 * moves either side of it are always readable, and any move is one tap
 * away.
 */
function MoveStrip({ moves, currentIndex, onSelect }: MoveStripProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const active = activeRef.current;
    if (!rail || !active) return;

    // Centred by hand rather than with `scrollIntoView`. That method
    // scrolls every scrollable ancestor, which on this screen drags the
    // whole review layout sideways; this moves only the rail.
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
            {/* The number belongs to the pair, so it is printed once, on
                White's move — the same convention as the notation itself,
                and it halves the noise in a strip this dense. */}
            {move.color === 'w' && <span className="strip-no num">{move.moveNumber}.</span>}
            {/* The classification colour rides on the SAN, not the
                button. A global `button{color:inherit}` rule outranks any
                zero-specificity default, so a class on the button itself
                silently loses its colour. */}
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
