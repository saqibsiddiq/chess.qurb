import { useEffect, useRef } from 'react';

const PIECE_PATHS = [
   'M12 2.6a3.3 3.3 0 0 1 1.9 6l.3 1.2h1.1c.2 2.6 1.1 5 2.5 7.1H6.2c1.4-2.1 2.3-4.5 2.5-7.1h1.1l.3-1.2a3.3 3.3 0 0 1 1.9-6zM5.2 18.6h13.6a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
   'M5.6 2.8h3.7v2.1h1.8V2.8h1.8v2.1h1.8V2.8h3.7v5.5l-1.9 1.8v5.4l1.9 1.8v1.3H5.6v-1.3l1.9-1.8V10.1L5.6 8.3zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
   'M12 1.6a1.8 1.8 0 0 1 1.3 3c2.6 2 4.1 4.5 4.1 6.9 0 2.2-1.2 3.8-2.5 4.7h-1.4l1.6-2.4-2.2-3.4-1 1.1 1.5 2.3-1.5 2.4H9.1c-1.3-.9-2.5-2.5-2.5-4.7 0-2.4 1.5-4.9 4.1-6.9a1.8 1.8 0 0 1 1.3-3zM8.4 17.2h7.2l.5 1.4H7.9zM5.2 18.6h13.6a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
   'M9.4 17.4c0-2.6 1-4 2.6-5.3 1.3-1 2-1.7 2-2.5 0-.5-.3-.9-.8-.9-.6 0-1 .4-1.6 1.2l-1.2 1.6-2.1-1.3 1.9-4.1C11.4 3.4 13.3 2 15.6 2c2.6 0 4.1 2 4.4 5 .3 3.2.2 7-.1 10.4zM5 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5a1.1 1.1 0 0 1-1.1-1.1v-1.6A1.1 1.1 0 0 1 5 18.6z',
   'M3.3 4.4a1.5 1.5 0 1 1 1 2.6l1.5 3.3 2.3-4.4a1.5 1.5 0 1 1 1.8-.1L12 9.6l2.1-3.8a1.5 1.5 0 1 1 1.8.1l2.3 4.4 1.5-3.3a1.5 1.5 0 1 1 1.2-.4l-2.6 8.6H6.7L4.1 6.6a1.5 1.5 0 0 1-.8-2.2zM6.9 16.2h10.2l.6 2.4H6.3zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
   'M11 1.2h2v2.1h2.1v2H13v2.4h-2V5.3H8.9v-2H11zM12 8.4c2.6-2.1 6.6-1.6 7.6 1.3.8 2.3-.6 4.3-2.3 5.6l-1.5 1.1H8.2l-1.5-1.1c-1.7-1.3-3.1-3.3-2.3-5.6C5.4 6.8 9.4 6.3 12 8.4zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
];

const ACCENTS: Array<[number, number, number]> = [
  [33, 191, 164],
  [50, 121, 249],
  [124, 179, 66],
  [232, 163, 61],
  [211, 68, 58],
];

const THEMES = {
  light: { rest: [158, 169, 187], restAlpha: 0.62, liveAlpha: 1.0 },
  dark: { rest: [104, 112, 130], restAlpha: 0.58, liveAlpha: 1.0 },
} as const;

const CONFIG = {
  density: 15000,
  densityNarrow: 7000,
  countRange: [34, 105],
  countRangeNarrow: [34, 64],
  sizeRange: [11, 26],
  sizeRangeNarrow: [9, 19],
  reach: 230,
  push: 0.85,
  wake: 0.05,
  maxSpeed: 4.5,
  damping: 0.93,
  drift: 0.16,
  spin: 0.0022,
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Piece {
  path: Path2D;
  accent: readonly [number, number, number];
  size: number;
  x: number; y: number;
  dx: number; dy: number;
  vx: number; vy: number;
  rot: number; spin: number;
  act: number;
  depth: number;
}

export interface PieceFieldProps {
  mode: 'live' | 'static';
  theme: 'light' | 'dark';
}

export default function PieceField({ mode, theme }: PieceFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const piecesRef = useRef<Piece[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const paths = PIECE_PATHS.map((d) => new Path2D(d));
    const palette = THEMES[theme];

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animated = mode === 'live' && !reduceMotion;

    let w = 0;
    let h = 0;
    let raf: number | null = null;
    const ptr = { x: -9999, y: -9999, px: -9999, py: -9999, vx: 0, vy: 0, on: false, hot: 0, pulse: 0 };

    const isNarrow = () => window.innerWidth < 768;
    const sizeRange = () => (isNarrow() ? CONFIG.sizeRangeNarrow : CONFIG.sizeRange);

    function spawn(): Piece {
      const [min, max] = sizeRange();
      return {
        path: paths[(Math.random() * paths.length) | 0],
        accent: ACCENTS[(Math.random() * ACCENTS.length) | 0],
        size: rand(min, max),
        x: Math.random() * w,
        y: Math.random() * h,
        dx: rand(-CONFIG.drift, CONFIG.drift),
        dy: rand(-CONFIG.drift, CONFIG.drift),
        vx: 0, vy: 0,
        rot: Math.random() * Math.PI * 2,
        spin: rand(-CONFIG.spin, CONFIG.spin),
        act: 0,
        depth: 0,
      };
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      if (!w || !h) return;

      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const [lo, hi] = isNarrow() ? CONFIG.countRangeNarrow : CONFIG.countRange;
      const density = isNarrow() ? CONFIG.densityNarrow : CONFIG.density;
      const target = Math.round(Math.min(hi, Math.max(lo, (w * h) / density)));

      const pieces = piecesRef.current;
      while (pieces.length < target) pieces.push(spawn());
      pieces.length = target;

      const [min, max] = sizeRange();
      for (const p of pieces) {
        p.size = Math.min(Math.max(p.size, min), max);
        p.depth = 0.45 + ((p.size - min) / (max - min)) * 0.55;
        if (p.x > w || p.y > h) { p.x = Math.random() * w; p.y = Math.random() * h; }
      }
    }

    function step(p: Piece) {
      let target = 0;
      const glow = ptr.on ? 1 : ptr.hot;

      if (glow > 0.02) {
        const dx = p.x - ptr.x;
        const dy = p.y - ptr.y;
        const dist = Math.hypot(dx, dy) || 0.001;

        if (dist < CONFIG.reach) {
          const t = 1 - dist / CONFIG.reach;

          if (ptr.on) {
            const force = t * t * CONFIG.push * p.depth * (1 + ptr.pulse * 1.6);

            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
            p.vx += ptr.vx * t * CONFIG.wake * p.depth;
            p.vy += ptr.vy * t * CONFIG.wake * p.depth;
          }

          target = t * glow;
        }
      }

      p.act += (target - p.act) * (target > p.act ? 0.22 : 0.035);

      const speed = Math.hypot(p.vx, p.vy);
      if (speed > CONFIG.maxSpeed) {
        p.vx = (p.vx / speed) * CONFIG.maxSpeed;
        p.vy = (p.vy / speed) * CONFIG.maxSpeed;
      }

      p.x += p.vx + p.dx;
      p.y += p.vy + p.dy;
      p.vx *= CONFIG.damping;
      p.vy *= CONFIG.damping;
      p.rot += p.spin * (1 + p.act * 5);

      const pad = p.size * 1.5;
      if (p.x < -pad) p.x = w + pad;
      else if (p.x > w + pad) p.x = -pad;
      if (p.y < -pad) p.y = h + pad;
      else if (p.y > h + pad) p.y = -pad;
    }

    function paint(p: Piece) {
      const ease = p.act * p.act * (3 - 2 * p.act);
      const scale = (p.size / 24) * (1 + ease * 0.45);
      const alpha = lerp(palette.restAlpha, palette.liveAlpha, ease) * lerp(0.55, 1, p.depth);

      const r = Math.round(lerp(palette.rest[0], p.accent[0], ease));
      const g = Math.round(lerp(palette.rest[1], p.accent[1], ease));
      const b = Math.round(lerp(palette.rest[2], p.accent[2], ease));

      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rot);
      ctx!.scale(scale, scale);
      ctx!.translate(-12, -12);
      ctx!.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      ctx!.fill(p.path);
      ctx!.restore();
    }

    function paintAll() {
      ctx!.clearRect(0, 0, w, h);
      for (const p of piecesRef.current) paint(p);
    }

    function frame() {
      ctx!.clearRect(0, 0, w, h);
      for (const p of piecesRef.current) { step(p); paint(p); }

      ptr.vx *= 0.86;
      ptr.vy *= 0.86;
      ptr.pulse *= 0.90;
      if (!ptr.on) ptr.hot *= 0.978;

      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf === null && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    }

    function at(e: PointerEvent) {
      return { x: e.clientX, y: e.clientY };
    }

    function onMove(e: PointerEvent) {
      const { x, y } = at(e);
      if (ptr.on) { ptr.vx = x - ptr.px; ptr.vy = y - ptr.py; }
      ptr.x = ptr.px = x;
      ptr.y = ptr.py = y;
      ptr.on = true;
      ptr.hot = 1;
    }

    function onDown(e: PointerEvent) {
      const { x, y } = at(e);
      ptr.x = ptr.px = x;
      ptr.y = ptr.py = y;
      ptr.vx = ptr.vy = 0;
      ptr.on = true;
      ptr.hot = 1;
      ptr.pulse = 1;
    }

    function release() {
      ptr.on = false;
      ptr.vx = ptr.vy = 0;
    }

    function onUp() {
      if (!window.matchMedia('(hover: hover)').matches) release();
    }

    function onVisibility() {
      if (document.hidden) stop();
      else if (animated) start();
    }

    let resizeTimer: number | undefined;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        if (!animated) paintAll();
      }, 150);
    }

    resize();
    window.addEventListener('resize', onResize);

    if (animated) {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onDown, { passive: true });
      window.addEventListener('pointerup', onUp, { passive: true });
      window.addEventListener('pointercancel', release, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      start();
    } else {
      paintAll();
    }

    return () => {
      stop();
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode, theme]);

  return <canvas ref={canvasRef} className="piece-field" aria-hidden="true" />;
}
