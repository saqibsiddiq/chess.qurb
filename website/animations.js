/**
 * Chesy — scroll reveals, sticky header and navigation
 */

(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Scroll reveals ─────────────────────────────────────────────── */

  if (!reduceMotion && 'IntersectionObserver' in window) {

    const revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('revealed');
        revealObserver.unobserve(entry.target);
      }
    }, { threshold: 0.1, rootMargin: '0px 0px -48px 0px' });

    document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

    /* Staggered groups: children cascade in once the group is in view. */
    document.querySelectorAll('.stagger-group').forEach((group) => {
      const items = group.querySelectorAll('.stagger-item');

      const groupObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          items.forEach((item, i) => {
            item.style.transitionDelay = Math.min(i * 55, 500) + 'ms';
            item.classList.add('revealed');
          });
          groupObserver.unobserve(entry.target);
        }
      }, { threshold: 0.1 });

      groupObserver.observe(group);
    });

  } else {
    document.querySelectorAll('.reveal, .stagger-item')
      .forEach((el) => el.classList.add('revealed'));
  }

  /* ── Evaluation bar in the product mock ─────────────────────────── */

  const evalFill = document.getElementById('eval-fill');

  if (evalFill && 'IntersectionObserver' in window) {
    // The mock ends in 16.Qxh7# — mate for White — so the bar has to
    // resolve toward White, not away from it.
    const stops = ['38%', '34%', '22%', '8%', '2%'];
    let i = 0;

    const evalObserver = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      evalObserver.disconnect();

      if (reduceMotion) { evalFill.style.height = '2%'; return; }

      const tick = setInterval(() => {
        evalFill.style.height = stops[i];
        if (++i >= stops.length) clearInterval(tick);
      }, 900);
    }, { threshold: 0.35 });

    evalObserver.observe(evalFill);
  }

  /* ── Sticky header ──────────────────────────────────────────────── */

  const header = document.getElementById('site-header');

  if (header) {
    let ticking = false;

    const update = () => {
      header.classList.toggle('scrolled', window.scrollY > 24);
      ticking = false;
    };

    window.addEventListener('scroll', () => {
      if (ticking) return;
      requestAnimationFrame(update);
      ticking = true;
    }, { passive: true });

    update();
  }

  /* ── Mobile navigation ──────────────────────────────────────────── */

  const navToggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('nav');

  function setNav(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle('open', open);
    navToggle.classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
    // Was never updated before, so assistive tech always announced the
    // menu as collapsed no matter what was on screen.
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      setNav(!nav.classList.contains('open'));
    });

    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setNav(false));
    });

    // An overlay whose only way out is one small control needs the usual
    // escape hatch.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        setNav(false);
        navToggle.focus();
      }
    });

    // Rotating a phone, or resizing past the breakpoint, would otherwise
    // strand the sheet open over a desktop layout with the toggle hidden.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 767 && nav.classList.contains('open')) setNav(false);
    });
  }

  /* ── Smooth anchor scrolling, offset for the fixed header ───────── */

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const id = anchor.getAttribute('href');
      if (!id || id === '#') return;

      const target = document.querySelector(id);
      if (!target) return;

      e.preventDefault();
      setNav(false);

      const offset = header ? header.offsetHeight + 16 : 0;
      const top = target.getBoundingClientRect().top + window.scrollY - offset;

      window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  });
})();
