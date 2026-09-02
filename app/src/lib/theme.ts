export type Theme = 'light' | 'dark';

const KEY = 'chesy.theme';

/// Resolves the theme to use on load: an explicit past choice wins,
/// otherwise follow the OS. Read before first paint (see main.tsx) so the
/// app never flashes the wrong ground.
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private mode / storage disabled — fall through to the OS setting.
  }
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember the choice shouldn't break switching it.
  }
}
