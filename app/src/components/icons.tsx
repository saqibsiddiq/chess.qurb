/** Shared inline icons. 24×24 grid, filled paths, currentColor via CSS. */

type P = { className?: string };

export const IconChevronLeft = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M15.3 4.7a1 1 0 0 1 0 1.4L9.4 12l5.9 5.9a1 1 0 0 1-1.4 1.4l-6.6-6.6a1 1 0 0 1 0-1.4l6.6-6.6a1 1 0 0 1 1.4 0z"/></svg>
);

export const IconChevronRight = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M8.7 4.7a1 1 0 0 1 1.4 0l6.6 6.6a1 1 0 0 1 0 1.4l-6.6 6.6a1 1 0 0 1-1.4-1.4l5.9-5.9-5.9-5.9a1 1 0 0 1 0-1.4z"/></svg>
);

export const IconSkipStart = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M7 5a1 1 0 0 1 1 1v4.8l7.4-5.6A1 1 0 0 1 17 6v12a1 1 0 0 1-1.6.8L8 13.2V18a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
);

export const IconSkipEnd = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M17 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0v-4.8l-7.4 5.6A1 1 0 0 1 7 18V6a1 1 0 0 1 1.6-.8L16 10.8V6a1 1 0 0 1 1-1z"/></svg>
);

export const IconBack = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M11 4.3a1 1 0 0 1 0 1.4L6.4 10.3H19a1 1 0 1 1 0 2H6.4l4.6 4.6a1 1 0 0 1-1.4 1.4l-6.3-6.3a1 1 0 0 1 0-1.4l6.3-6.3a1 1 0 0 1 1.4 0z"/></svg>
);

export const IconFlip = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 3a1 1 0 0 1 1 1v3.6l2-1.5a1 1 0 0 1 1.2 1.6l-3.6 2.7a1 1 0 0 1-1.2 0L7.8 7.7A1 1 0 0 1 9 6.1l2 1.5V4a1 1 0 0 1 1-1zm-.6 10.6a1 1 0 0 1 1.2 0l3.6 2.7a1 1 0 0 1-1.2 1.6l-2-1.5V20a1 1 0 1 1-2 0v-3.6l-2 1.5a1 1 0 0 1-1.2-1.6z"/></svg>
);

export const IconTarget = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 2a1 1 0 0 1 1 1v1.1a7.9 7.9 0 0 1 6.9 6.9H21a1 1 0 1 1 0 2h-1.1a7.9 7.9 0 0 1-6.9 6.9V21a1 1 0 1 1-2 0v-1.1A7.9 7.9 0 0 1 4.1 13H3a1 1 0 1 1 0-2h1.1A7.9 7.9 0 0 1 11 4.1V3a1 1 0 0 1 1-1zm0 4.1A5.9 5.9 0 1 0 12 17.9 5.9 5.9 0 0 0 12 6.1zm0 3.4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>
);

export const IconUpload = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 3a1 1 0 0 1 .7.3l4.5 4.5a1 1 0 1 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.2 9.2a1 1 0 0 1-1.4-1.4l4.5-4.5A1 1 0 0 1 12 3zM4 16a1 1 0 0 1 1 1v2h14v-2a1 1 0 1 1 2 0v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/></svg>
);

export const ChesyMark = (p: P) => (
  /* A king, drawn as three solid shapes so it still reads as a king at
     24px — the size it is actually used at. Proportions were taken from
     a CC0 chess set on Wikimedia Commons (Chess pieces, Qwertyxp2000,
     public domain, no attribution required); that artwork is far too
     detailed to use directly at this size, so this is a redraw rather
     than a copy, and carries no licence obligations either way. */
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <path d="M12.9 1.6a.95.95 0 0 0-1.9 0v1.2H9.7a.95.95 0 0 0 0 1.9H11v1.6a.95.95 0 0 0 1.9 0V4.7h1.4a.95.95 0 0 0 0-1.9h-1.4V1.6z" />
    <path d="M12 7.4c-1.7-1.4-4-1.6-5.6-.6-2 1.2-2.6 3.7-1.4 5.7.6 1 1.4 1.9 2.3 2.6l.9.7h7.6l.9-.7c.9-.7 1.7-1.6 2.3-2.6 1.2-2 .6-4.5-1.4-5.7-1.6-1-3.9-.8-5.6.6z" />
    <path d="M5.4 17.6h13.2a1.5 1.5 0 0 1 1.5 1.5v1.4a1.5 1.5 0 0 1-1.5 1.5H5.4a1.5 1.5 0 0 1-1.5-1.5v-1.4a1.5 1.5 0 0 1 1.5-1.5z" />
  </svg>
);

export const IconGlobe = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15.6 15.6 0 0 0-1.3-5.6A8 8 0 0 1 18.9 11zM12 4.2c.8 1.1 1.7 3.3 1.9 6.8h-3.8c.2-3.5 1.1-5.7 1.9-6.8zM5.1 11a8 8 0 0 1 4.3-5.6A15.6 15.6 0 0 0 8.1 11zm0 2h3c.1 2.2.6 4.1 1.3 5.6A8 8 0 0 1 5.1 13zm6.9 6.8c-.8-1.1-1.7-3.3-1.9-6.8h3.8c-.2 3.5-1.1 5.7-1.9 6.8zm2.6-1.2c.7-1.5 1.2-3.4 1.3-5.6h3a8 8 0 0 1-4.3 5.6z"/></svg>
);

export const IconFolder = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M3.8 5h5.3a1 1 0 0 1 .8.4L11.4 7H20a1.8 1.8 0 0 1 1.8 1.8v8.4A1.8 1.8 0 0 1 20 19H4a1.8 1.8 0 0 1-1.8-1.8V6.8A1.8 1.8 0 0 1 3.8 5zm.4 2v10h15.6V9h-8.6a1 1 0 0 1-.8-.4L8.6 7z"/></svg>
);

export const IconSearch = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.2a1 1 0 0 1-1.4 1.4l-4.3-4.2A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
);

export const IconPaste = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M9 2h6a1 1 0 0 1 1 1v1h2.2A1.8 1.8 0 0 1 20 5.8v14.4A1.8 1.8 0 0 1 18.2 22H5.8A1.8 1.8 0 0 1 4 20.2V5.8A1.8 1.8 0 0 1 5.8 4H8V3a1 1 0 0 1 1-1zm-3 4v14h12V6h-2v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V6zm4-2v1h4V4z"/></svg>
);

// Stacked rows: the reviewed-games library, matching the solid-fill,
// 24×24 convention every other icon here uses.
export const IconLibrary = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M4 4.8A1.8 1.8 0 0 1 5.8 3h12.4A1.8 1.8 0 0 1 20 4.8v3.4A1.8 1.8 0 0 1 18.2 10H5.8A1.8 1.8 0 0 1 4 8.2zm2 .2v3h12V5zm-2 8.8A1.8 1.8 0 0 1 5.8 12h12.4A1.8 1.8 0 0 1 20 13.8v1.4A1.8 1.8 0 0 1 18.2 17H5.8A1.8 1.8 0 0 1 4 15.2zm2 .2v1h12v-1zm-2 5.3A1.1 1.1 0 0 1 5.1 18h13.8a1.1 1.1 0 0 1 0 2.2H5.1A1.1 1.1 0 0 1 4 19.1z"/></svg>
);

// Sun / moon for the theme toggle, same 24×24 solid-fill convention.
export const IconSun = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM11 1.8h2v3.1h-2zm0 17.3h2v3.1h-2zM1.8 11h3.1v2H1.8zm17.3 0h3.1v2h-3.1zM4.2 5.6l1.4-1.4 2.2 2.2-1.4 1.4zm11.9 11.9 1.4-1.4 2.2 2.2-1.4 1.4zM17.5 6.4l-1.4-1.4 2.2-2.2 1.4 1.4zM5.6 19.8l-1.4-1.4 2.2-2.2 1.4 1.4z"/></svg>
);

export const IconMoon = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12.7 2.1a1 1 0 0 1 .3 1.2 7.4 7.4 0 0 0 9.4 9.9 1 1 0 0 1 1.3 1.3A10 10 0 1 1 11.5 1.8a1 1 0 0 1 1.2.3zM10 4.1a8 8 0 1 0 10.5 10.4A9.4 9.4 0 0 1 10 4.1z"/></svg>
);

export const IconClose = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M6.2 4.8a1 1 0 0 0-1.4 1.4l5.8 5.8-5.8 5.8a1 1 0 1 0 1.4 1.4l5.8-5.8 5.8 5.8a1 1 0 0 0 1.4-1.4L13.4 12l5.8-5.8a1 1 0 0 0-1.4-1.4L12 10.6z"/></svg>
);

export const IconChart = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M3.3 15.3a1 1 0 0 1 .1-1.4l5.2-4.5a1 1 0 0 1 1.2-.1l3.6 2.3 5-4.9a1 1 0 1 1 1.4 1.4l-5.6 5.5a1 1 0 0 1-1.2.1L9.4 11.5l-4.7 4a1 1 0 0 1-1.4-.2zM4 18h16a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2z"/></svg>
);

export const IconClock = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8zm0 2a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8zM12 6.5a1 1 0 0 1 1 1v4.1l2.8 1.6a1 1 0 1 1-1 1.8l-3.3-1.9a1 1 0 0 1-.5-.9V7.5a1 1 0 0 1 1-1z"/></svg>
);

export const IconChevronDown = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M4.7 8.7a1 1 0 0 1 1.4 0L12 14.6l5.9-5.9a1 1 0 1 1 1.4 1.4l-6.6 6.6a1 1 0 0 1-1.4 0L4.7 10.1a1 1 0 0 1 0-1.4z"/></svg>
);

export const IconSettings = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M4 6.2h6.2a2.9 2.9 0 0 1 5.6 0H20a1 1 0 1 1 0 2h-4.2a2.9 2.9 0 0 1-5.6 0H4a1 1 0 0 1 0-2zm9 1a1.9 1.9 0 1 0-3.8 0 1.9 1.9 0 0 0 3.8 0zM4 15.8h2.2a2.9 2.9 0 0 1 5.6 0H20a1 1 0 1 1 0 2h-8.2a2.9 2.9 0 0 1-5.6 0H4a1 1 0 1 1 0-2zm6.9 1a1.9 1.9 0 1 0-3.8 0 1.9 1.9 0 0 0 3.8 0z"/></svg>
);

/* Marks for the two services, drawn here rather than shipped as brand
   assets: a knight for Lichess and a pawn for Chess.com, each in that
   service's colour. They are recognisable stand-ins used to identify the
   site you are connecting to, not copies of the official logos. */
export const IconLichess = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M9.4 17.4c0-2.6 1-4 2.6-5.3 1.3-1 2-1.7 2-2.5 0-.5-.3-.9-.8-.9-.6 0-1 .4-1.6 1.2l-1.2 1.6-2.1-1.3 1.9-4.1C11.4 3.4 13.3 2 15.6 2c2.6 0 4.1 2 4.4 5 .3 3.2.2 7-.1 10.4zM5 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5a1.1 1.1 0 0 1-1.1-1.1v-1.6A1.1 1.1 0 0 1 5 18.6z"/></svg>
);

export const IconChessCom = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 2.6a3.3 3.3 0 0 1 1.9 6l.3 1.2h1.1c.2 2.6 1.1 5 2.5 7.1H6.2c1.4-2.1 2.3-4.5 2.5-7.1h1.1l.3-1.2a3.3 3.3 0 0 1 1.9-6zM5.2 18.6h13.6a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z"/></svg>
);
