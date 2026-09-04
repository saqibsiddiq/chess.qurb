export type ThemeChoice = 'light' | 'dark' | 'system';
export type MotionChoice = 'animated' | 'static';
export type DepthChoice = 'fast' | 'deep';
export type BoardChoice = 'slate' | 'classic' | 'ocean' | 'walnut';

export interface Settings {
  theme: ThemeChoice;
  motion: MotionChoice;
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
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
  }
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.theme);
  root.dataset.board = settings.board;
}
