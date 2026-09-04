/**
 * Chesy: cursor-reactive chess field
 *
 * A calm, always-visible drift of tiny chess pieces. Moving the cursor
 * through the field pushes the nearest pieces aside, drags them along in
 * its wake, and "colours them in". Each piece eases from a neutral grey
 * to the accent of a move classification, then settles back once the
 * cursor moves on.
 *
 * Pieces are drawn as vector silhouettes rather than Unicode glyphs:
 * Google Fonts' subsets do not ship the U+2654–265F chess block, so
 * glyph-based pieces render as tofu on machines without a symbol font.
 */

(function () {
  'use strict';

  /* ── Piece silhouettes, authored on a 24×24 grid ───────────────── */

  const PIECE_PATHS = [
    /* pawn   */ 'M12 2.6a3.3 3.3 0 0 1 1.9 6l.3 1.2h1.1c.2 2.6 1.1 5 2.5 7.1H6.2c1.4-2.1 2.3-4.5 2.5-7.1h1.1l.3-1.2a3.3 3.3 0 0 1 1.9-6zM5.2 18.6h13.6a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
    /* rook   */ 'M5.6 2.8h3.7v2.1h1.8V2.8h1.8v2.1h1.8V2.8h3.7v5.5l-1.9 1.8v5.4l1.9 1.8v1.3H5.6v-1.3l1.9-1.8V10.1L5.6 8.3zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
    /* bishop */ 'M12 1.6a1.8 1.8 0 0 1 1.3 3c2.6 2 4.1 4.5 4.1 6.9 0 2.2-1.2 3.8-2.5 4.7h-1.4l1.6-2.4-2.2-3.4-1 1.1 1.5 2.3-1.5 2.4H9.1c-1.3-.9-2.5-2.5-2.5-4.7 0-2.4 1.5-4.9 4.1-6.9a1.8 1.8 0 0 1 1.3-3zM8.4 17.2h7.2l.5 1.4H7.9zM5.2 18.6h13.6a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
    /* knight */ 'M9.4 17.4c0-2.6 1-4 2.6-5.3 1.3-1 2-1.7 2-2.5 0-.5-.3-.9-.8-.9-.6 0-1 .4-1.6 1.2l-1.2 1.6-2.1-1.3 1.9-4.1C11.4 3.4 13.3 2 15.6 2c2.6 0 4.1 2 4.4 5 .3 3.2.2 7-.1 10.4zM5 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5a1.1 1.1 0 0 1-1.1-1.1v-1.6A1.1 1.1 0 0 1 5 18.6z',
    /* queen  */ 'M3.3 4.4a1.5 1.5 0 1 1 1 2.6l1.5 3.3 2.3-4.4a1.5 1.5 0 1 1 1.8-.1L12 9.6l2.1-3.8a1.5 1.5 0 1 1 1.8.1l2.3 4.4 1.5-3.3a1.5 1.5 0 1 1 1.2-.4l-2.6 8.6H6.7L4.1 6.6a1.5 1.5 0 0 1-.8-2.2zM6.9 16.2h10.2l.6 2.4H6.3zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
    /* king   */ 'M11 1.2h2v2.1h2.1v2H13v2.4h-2V5.3H8.9v-2H11zM12 8.4c2.6-2.1 6.6-1.6 7.6 1.3.8 2.3-.6 4.3-2.3 5.6l-1.5 1.1H8.2l-1.5-1.1c-1.7-1.3-3.1-3.3-2.3-5.6C5.4 6.8 9.4 6.3 12 8.4zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z',
  ].map((d) => new Path2D(d));

  /* Move-classification accents: the colour a piece warms to. */
  const ACCENTS = [
    [33, 191, 164],   // brilliant
    [50, 121, 249],   // great
    [124, 179, 66],   // best
    [232, 163, 61],   // inaccuracy
    [211, 68, 58],    // blunder
  ];

  const THEMES = {
    light: { rest: [158, 169, 187], restAlpha: 0.88, liveAlpha: 1.00 },
    dark:  { rest: [104, 112, 130], restAlpha: 0.85, liveAlpha: 1.00 },
  };

  const CONFIG = {
    /** One piece per this many square px of canvas. */
    density: 15000,
    countRange: [26, 105],
    sizeRange: [11, 26],
    /** Narrow viewports get smaller pieces so the field stays background. */
    sizeRangeNarrow: [8, 17],
    /** Cursor influence radius, px. */
    reach: 230,
    /** Outward shove strength within reach. */
    push: 0.85,
    /** How strongly pointer travel drags pieces along. */
    wake: 0.05,
    maxSpeed: 4.5,
    damping: 0.93,
    /** Ambient drift, px/frame. */
    drift: 0.16,
    spin: 0.0022,
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── One field per canvas ──────────────────────────────────────── */

  function createField(canvas, themeName) {
    const ctx = canvas.getContext('2d');
    const theme = THEMES[themeName];
    const host = canvas.parentElement;

    let w = 0, h = 0, pieces = [], raf = null, visible = true;
    const ptr = { x: -9999, y: -9999, px: -9999, py: -9999, vx: 0, vy: 0, on: false };

    function sizeRange() {
      return window.innerWidth < 768 ? CONFIG.sizeRangeNarrow : CONFIG.sizeRange;
    }

    function spawn(initial) {
      const [min, max] = sizeRange();
      return {
        path: PIECE_PATHS[(Math.random() * PIECE_PATHS.length) | 0],
        accent: ACCENTS[(Math.random() * ACCENTS.length) | 0],
        size: rand(min, max),
        x: initial ? Math.random() * w : rand(-40, w + 40),
        y: initial ? Math.random() * h : rand(-40, h + 40),
        dx: rand(-CONFIG.drift, CONFIG.drift),
        dy: rand(-CONFIG.drift, CONFIG.drift),
        vx: 0, vy: 0,
        rot: Math.random() * Math.PI * 2,
        spin: rand(-CONFIG.spin, CONFIG.spin),
        /** 0 = at rest, 1 = fully lit by the cursor. */
        act: 0,
        /** Parallax weight: small pieces sit "further away" and react less. */
        depth: 0,
      };
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = host.offsetWidth;
      h = host.offsetHeight;
      if (!w || !h) return;

      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = Math.round(
        Math.min(CONFIG.countRange[1],
        Math.max(CONFIG.countRange[0], (w * h) / CONFIG.density))
      );

      while (pieces.length < target) pieces.push(spawn(true));
      pieces.length = target;

      const [min, max] = sizeRange();
      for (const p of pieces) {
        p.size = Math.min(Math.max(p.size, min), max);
        p.depth = 0.45 + ((p.size - min) / (max - min)) * 0.55;
      }
    }

    function step(p) {
      let target = 0;

      if (ptr.on) {
        const dx = p.x - ptr.x;
        const dy = p.y - ptr.y;
        const dist = Math.hypot(dx, dy) || 0.001;

        if (dist < CONFIG.reach) {
          const t = 1 - dist / CONFIG.reach;
          const force = t * t * CONFIG.push * p.depth;

          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;

          // Dragged along in the pointer's wake
          p.vx += ptr.vx * t * CONFIG.wake * p.depth;
          p.vy += ptr.vy * t * CONFIG.wake * p.depth;

          target = t;
        }
      }

      // Activation eases in fast, fades out slowly
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

      // Wrap with a margin so pieces never pop in mid-canvas
      const pad = p.size * 1.5;
      if (p.x < -pad) p.x = w + pad;
      else if (p.x > w + pad) p.x = -pad;
      if (p.y < -pad) p.y = h + pad;
      else if (p.y > h + pad) p.y = -pad;
    }

    function paint(p) {
      const ease = p.act * p.act * (3 - 2 * p.act);   // smoothstep
      const scale = (p.size / 24) * (1 + ease * 0.45);
      const alpha = lerp(theme.restAlpha, theme.liveAlpha, ease) *
                    lerp(0.55, 1, p.depth);

      const r = Math.round(lerp(theme.rest[0], p.accent[0], ease));
      const g = Math.round(lerp(theme.rest[1], p.accent[1], ease));
      const b = Math.round(lerp(theme.rest[2], p.accent[2], ease));

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(scale, scale);
      ctx.translate(-12, -12);
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(3) + ')';
      ctx.fill(p.path);
      ctx.restore();
    }

    function frame() {
      ctx.clearRect(0, 0, w, h);
      for (const p of pieces) { step(p); paint(p); }

      // Pointer velocity decays so the wake fades when the cursor stops
      ptr.vx *= 0.86;
      ptr.vy *= 0.86;

      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf === null && visible) raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    }

    /* ── Pointer, tracked on the host so content above the canvas
          (headings, buttons) does not create dead zones ─────────── */

    function onPointerMove(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (ptr.on) {
        ptr.vx = x - ptr.px;
        ptr.vy = y - ptr.py;
      }
      ptr.x = ptr.px = x;
      ptr.y = ptr.py = y;
      ptr.on = true;
    }

    function onPointerLeave() {
      ptr.on = false;
      ptr.vx = ptr.vy = 0;
      ptr.x = ptr.y = -9999;
    }

    host.addEventListener('pointermove', onPointerMove, { passive: true });
    host.addEventListener('pointerleave', onPointerLeave, { passive: true });
    host.addEventListener('pointercancel', onPointerLeave, { passive: true });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });

    // Don't burn frames on a field that has scrolled out of view
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        if (reduceMotion) return;
        visible ? start() : stop();
      }, { threshold: 0 }).observe(host);
    }

    resize();

    if (reduceMotion) {
      // Static field: draw once, no animation loop.
      ctx.clearRect(0, 0, w, h);
      for (const p of pieces) paint(p);
    } else {
      start();
    }
  }

  /* ── Boot ──────────────────────────────────────────────────────── */

  function boot() {
    const hero = document.getElementById('hero-canvas');
    const cta = document.getElementById('cta-canvas');
    if (hero) createField(hero, 'light');
    if (cta) createField(cta, 'dark');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
