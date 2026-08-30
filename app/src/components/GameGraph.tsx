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

export default function GameGraph({ moves, totalMoves, currentIndex, onSelect }: GameGraphProps) {
  if (totalMoves === 0) return null;

  const step = WIDTH / totalMoves;
  const linePoints = [
    `0,${HEIGHT / 2}`,
    ...moves.map((m, i) => `${(i + 1) * step},${evalToY(m.evalAfter.cp, m.evalAfter.mate)}`),
  ].join(' ');

  return (
    <svg
      className="game-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
    >
      <line x1={0} y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="graph-midline" />
      <polyline points={linePoints} className="graph-line" fill="none" />
      {moves.map((m, i) => (
        <circle
          key={i}
          cx={(i + 1) * step}
          cy={evalToY(m.evalAfter.cp, m.evalAfter.mate)}
          r={i === currentIndex ? 4 : 2.5}
          className={`graph-point graph-point-${m.classification}`}
          aria-label={`Move ${m.moveNumber} ${m.san}`}
          onClick={() => onSelect(i)}
        />
      ))}
    </svg>
  );
}
