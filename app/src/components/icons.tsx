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
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M11 1.2h2v2.1h2.1v2H13v2.4h-2V5.3H8.9v-2H11zM12 8.4c2.6-2.1 6.6-1.6 7.6 1.3.8 2.3-.6 4.3-2.3 5.6l-1.5 1.1H8.2l-1.5-1.1c-1.7-1.3-3.1-3.3-2.3-5.6C5.4 6.8 9.4 6.3 12 8.4zM4.6 18.6h14.8a1.1 1.1 0 0 1 1.1 1.1v1.6a1.1 1.1 0 0 1-1.1 1.1H4.6a1.1 1.1 0 0 1-1.1-1.1v-1.6a1.1 1.1 0 0 1 1.1-1.1z"/></svg>
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
