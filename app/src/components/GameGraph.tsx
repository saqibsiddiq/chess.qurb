import { memo, useCallback, useMemo, useRef } from 'react';
import type { ReviewedMove } from '../lib/reviewEngine.ts';

interface GameGraphProps {
  moves: ReviewedMove[];
  // Fixes horizontal spacing to the game's full move count, independent
  // of how many moves are classified so far — without this, the graph
  // would re-space every existing point each time a new move arrives
  // during an in-progress review.
  totalMoves: number;
  currentIndex: number;
  onSelect: (index: number) => void;
}

const WIDTH = 600;
const HEIGHT = 100;

/// Classifications worth marking on the curve. Everything else is
/// ordinary play and only adds noise to a 600×100 strip.
const NOTABLE: ReadonlySet<string> = new Set([
  'brilliant',
  'great',
  'miss',
  'mistake',
  'blunder',
]);

function evalToY(cp: number | null, mate: number | null): number {
  let percent: number;
  if (mate !== null) {
    percent = mate > 0 ? 100 : 0;
  } else {
    const capped = Math.max(-1000, Math.min(1000, cp ?? 0));
    percent = 50 + (capped / 1000) * 50;
  }
  return HEIGHT - (percent / 100) * HEIGHT;
}

function GameGraph({ moves, totalMoves, currentIndex, onSelect }: GameGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const step = totalMoves > 0 ? WIDTH / totalMoves : 0;

  const points = useMemo(
    () =>
      moves.map((m, i) => ({
        x: (i + 1) * step,
        y: evalToY(m.evalAfter.cp, m.evalAfter.mate),
        classification: m.classification,
      })),
    [moves, step],
  );

  const linePoints = useMemo(
    () => [`0,${HEIGHT / 2}`, ...points.map((p) => `${p.x},${p.y}`)].join(' '),
    [points],
  );

  // The same path closed along the midline. A bare polyline on an empty
  // panel reads as a stray scribble; the filled swing reads as evaluation.
  const areaPoints = useMemo(() => {
    if (points.length === 0) return '';
    const last = points[points.length - 1];
    return [
      `0,${HEIGHT / 2}`,
      ...points.map((p) => `${p.x},${p.y}`),
      `${last.x},${HEIGHT / 2}`,
    ].join(' ');
  }, [points]);

  // A single transparent overlay handles all pointer input, instead of a
  // hit target per move. The dots themselves are 2.5px — far below the
  // ~44px minimum touch target — and `preserveAspectRatio="none"` makes
  // that worse, stretching the graph horizontally but not vertically so
  // the dots become thin slivers on a phone. Mapping x-position to an
  // index gives every move a full-height target *and* keeps the node
  // count flat: one rect regardless of game length, rather than doubling
  // the SVG for a 150-ply game.
  const indexFromEvent = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg || step === 0 || moves.length === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      // preserveAspectRatio="none" means viewBox units map linearly onto
      // the rendered box on each axis independently, so this is exact.
      const viewBoxX = ((clientX - rect.left) / rect.width) * WIDTH;
      const index = Math.round(viewBoxX / step) - 1;
      return Math.max(0, Math.min(moves.length - 1, index));
    },
    [step, moves.length],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const index = indexFromEvent(e.clientX);
      if (index === null) return;
      // Capture so a drag keeps scrubbing even if the finger leaves the
      // graph vertically, which is easy to do on a 90px-tall element.
      e.currentTarget.setPointerCapture(e.pointerId);
      onSelect(index);
    },
    [indexFromEvent, onSelect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const index = indexFromEvent(e.clientX);
      if (index !== null) onSelect(index);
    },
    [indexFromEvent, onSelect],
  );

  if (totalMoves === 0) return null;

  return (
    <svg
      ref={svgRef}
      className="game-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Evaluation across ${totalMoves} moves. Use the move list to navigate.`}
    >
      {/* Split at the midline so the shape reads as *who* is better, not
          just that something changed: the swing above the line belongs to
          White, below it to Black. */}
      <defs>
        <clipPath id="cg-white-half">
          <rect x={0} y={0} width={WIDTH} height={HEIGHT / 2} />
        </clipPath>
        <clipPath id="cg-black-half">
          <rect x={0} y={HEIGHT / 2} width={WIDTH} height={HEIGHT / 2} />
        </clipPath>
      </defs>

      {areaPoints && (
        <>
          <polygon points={areaPoints} className="graph-area-white" clipPath="url(#cg-white-half)" />
          <polygon points={areaPoints} className="graph-area-black" clipPath="url(#cg-black-half)" />
        </>
      )}
      {/* A tick every 10 full moves: without any horizontal reference the
          curve says "it got worse" but never "it got worse around move 30". */}
      {Array.from({ length: Math.floor(totalMoves / 20) }, (_, k) => {
        const ply = (k + 1) * 20;
        return (
          <g key={`tick-${ply}`}>
            <line x1={ply * step} y1={0} x2={ply * step} y2={HEIGHT} className="graph-tick" />
            <text x={ply * step + 3} y={HEIGHT - 3} className="graph-tick-label">
              {ply / 2}
            </text>
          </g>
        );
      })}

      <line x1={0} y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="graph-midline" />
      <polyline points={linePoints} className="graph-line" fill="none" />

      {currentIndex >= 0 && currentIndex < points.length && (
        <line
          x1={points[currentIndex].x}
          y1={0}
          x2={points[currentIndex].x}
          y2={HEIGHT}
          className="graph-cursor"
        />
      )}

      {points.map((p, i) =>
        // A dot on every ply made the line unreadable and spent the
        // classification colours on moves nobody needs flagged. Only the
        // moves worth revisiting are marked; the current one always is,
        // so the cursor has something to land on.
        NOTABLE.has(p.classification) || i === currentIndex ? (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === currentIndex ? 4 : 3}
            className={`graph-point graph-point-${p.classification}`}
          />
        ) : null,
      )}

      <rect
        className="graph-hit"
        x={0}
        y={0}
        width={WIDTH}
        height={HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      />
    </svg>
  );
}

// The graph re-renders on every review-progress event because `moves`
// genuinely grows; memo is here to skip the unrelated re-renders (an SLM
// explanation arriving, an arrows/orientation toggle, engine status).
export default memo(GameGraph);
