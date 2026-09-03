/**
 * User preferences, kept in localStorage.
 *
 * Values are validated on the way out rather than trusted, for the same
 * reason `account.ts` does it: what comes back is whatever was in the
 * browser's storage, which is not necessarily what this app last wrote.
 * A stale or hand-edited key must degrade to the default, never put the
 * app into a state it has no styling or behaviour for.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type MotionChoice = 'animated' | 'static';
export type DepthChoice = 'fast' | 'deep';
export type BoardChoice = 'slate' | 'classic' | 'ocean' | 'walnut';

export interface Settings {
  theme: ThemeChoice;
  /** Whether the chess-piece background drifts or is painted once. */
  motion: MotionChoice;
  /** Which depth a review starts at, rather than a per-review toggle. */
  depth: DepthChoice;
  board: BoardChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  motion: 'animated',
  depth: 'deep',
  board: 'slate',
};

const KEY = 'chesy.settings';

const THEMES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
const MOTIONS: readonly MotionChoice[] = ['animated', 'static'];
const DEPTHS: readonly DepthChoice[] = ['fast', 'deep'];
const BOARDS: readonly BoardChoice[] = ['slate', 'classic', 'ocean', 'walnut'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      theme: pick(parsed.theme, THEMES, DEFAULT_SETTINGS.theme),
      motion: pick(parsed.motion, MOTIONS, DEFAULT_SETTINGS.motion),
      depth: pick(parsed.depth, DEPTHS, DEFAULT_SETTINGS.depth),
      board: pick(parsed.board, BOARDS, DEFAULT_SETTINGS.board),
    };
  } catch {
    // Unparseable, or storage unavailable in a private window.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember a preference must not stop it applying
    // for this session.
  }
}

/** Resolves `system` against the OS, for the two values the DOM knows. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  // `globalThis` rather than `window`: identical in a browser, and it
  // keeps the OS lookup reachable where there is no `window` object at
  // all, which is both the test environment and any future prerender.
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies everything that lives on the document root.
 *
 * Board and theme are separate attributes because they are separate
 * choices: a walnut board should look like walnut in either theme, so the
 * board's tokens are keyed off `data-board` and the theme's off
 * `data-theme`, and neither has to enumerate the other.
 */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.theme);
  root.dataset.board = settings.board;
}
