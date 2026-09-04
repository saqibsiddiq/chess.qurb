import { useCallback, useEffect, useRef, useState } from 'react';
import ChessBoard from './ChessBoard';
import type { BoardShape } from '../lib/explanations';

interface BoardStageProps {
  fen: string;
  evalPercent: number;
  shapes: BoardShape[];
  orientation: 'white' | 'black';
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onStart: () => void;
  onEnd: () => void;
  onMeasure?: (px: number) => void;
  interactive?: boolean;
  onMove?: (from: string, to: string) => void;
}

const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 500;
const HOLD_MS = 450;
const SWIPE_MIN_PX = 40;
const SWIPE_RATIO = 1.6;
const RAIL_TOTAL_PX = 12;

type Zone = 'prev' | 'next' | 'center';

export default function BoardStage({
  fen,
  evalPercent,
  shapes,
  orientation,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  onStart,
  onEnd,
  onMeasure,
  interactive = false,
  onMove,
}: BoardStageProps) {
  const fitRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState(0);

  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const usableWidth = width - RAIL_TOTAL_PX;
      setBoardPx(Math.max(0, Math.floor(Math.min(usableWidth, height))));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onMeasure?.(boardPx);
  }, [boardPx, onMeasure]);

  const pointer = useRef<{ x: number; y: number; t: number; zone: Zone } | null>(null);
  const held = useRef(false);
  const holdTimer = useRef<number | undefined>(undefined);

  const [flashed, setFlashed] = useState<Zone | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hinting, setHinting] = useState(true);

  const flashTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    window.clearTimeout(flashTimer.current);
    window.clearTimeout(toastTimer.current);
  }, []);

  const flash = useCallback((zone: Zone) => {
    setFlashed(zone);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashed(null), 160);
  }, []);

  const announce = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 900);
  }, []);

  const step = useCallback(
    (zone: Zone) => {
      if (zone === 'prev') {
        if (!canPrevious) return;
        onPrevious();
      } else if (zone === 'next') {
        if (!canNext) return;
        onNext();
      }
      flash(zone);
      setHinting(false);
    },
    [canPrevious, canNext, onPrevious, onNext, flash],
  );

  const jump = useCallback(
    (zone: Zone) => {
      if (zone === 'prev') {
        if (!canPrevious) return;
        onStart();
        announce('Starting position');
      } else {
        if (!canNext) return;
        onEnd();
        announce('Final position');
      }
      flash(zone);
      setHinting(false);
    },
    [canPrevious, canNext, onStart, onEnd, flash, announce],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const zone = (e.currentTarget.dataset.zone ?? 'center') as Zone;
      pointer.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, zone };
      held.current = false;
      window.clearTimeout(holdTimer.current);
      if (zone === 'center') return;
      holdTimer.current = window.setTimeout(() => {
        if (!pointer.current || pointer.current.zone !== zone) return;
        held.current = true;
        jump(zone);
      }, HOLD_MS);
    },
    [jump],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = pointer.current;
      pointer.current = null;
      window.clearTimeout(holdTimer.current);
      if (!start) return;
      if (held.current) { held.current = false; return; }

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const elapsed = e.timeStamp - start.t;

      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) {
        step(dx < 0 ? 'next' : 'prev');
        return;
      }

      if (Math.hypot(dx, dy) > TAP_SLOP_PX || elapsed > TAP_MAX_MS) return;
      if (start.zone === 'center') return;

      step(start.zone);
    },
    [step],
  );

  const handlePointerCancel = useCallback(() => {
    window.clearTimeout(holdTimer.current);
    held.current = false;
    pointer.current = null;
  }, []);

  const zoneProps = (zone: Zone, disabled: boolean) => ({
    'data-zone': zone,
    className:
      `step-zone is-${zone === 'center' ? 'center' : zone}` +
      (flashed === zone ? ' is-flashed' : '') +
      (disabled ? ' is-disabled' : ''),
    onPointerDown: handlePointerDown,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
  });

  return (
    <div className="board-fit" ref={fitRef} style={{ ['--board-px' as string]: `${boardPx}px` }}>
      <div
        className="eval-rail"
        role="img"
        aria-label={`White holds ${Math.round(evalPercent)} percent of the evaluation`}
      >
        <div className="eval-rail-white" style={{ height: `${evalPercent}%` }} />
      </div>

      <div className="board-square">
        <ChessBoard
          fen={fen}
          shapes={shapes}
          orientation={orientation}
          interactive={interactive}
          onMove={onMove}
        />

        {!interactive && (
          <div
            className={`step-zones${hinting ? ' is-hinting' : ''}`}
            role="group"
            aria-label="Tap the left or right of the board to step through the game; press and hold to jump to the start or end"
          >
            <div {...zoneProps('prev', !canPrevious)} />
            <div {...zoneProps('center', false)} />
            <div {...zoneProps('next', !canNext)} />
          </div>
        )}

        {toast && !interactive && <div className="jump-toast">{toast}</div>}
      </div>
    </div>
  );
}
