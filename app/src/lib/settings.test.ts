import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resolveTheme,
  saveSettings,
  type Settings,
} from './settings';

const KEY = 'chesy.settings';

/**
 * The suite runs on node, with no DOM — the rest of the codebase's tests
 * are pure logic and adding jsdom would slow all of them down for one
 * module. A few lines of in-memory storage is enough to exercise the part
 * that matters here, which is the validation, not the browser API.
 */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

describe('settings storage', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = stubStorage(); });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the defaults when nothing has been saved', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a full set of choices', () => {
    const chosen: Settings = {
      theme: 'light',
      motion: 'static',
      depth: 'fast',
      board: 'walnut',
    };
    saveSettings(chosen);
    expect(loadSettings()).toEqual(chosen);
  });

  it('falls back per field rather than discarding the whole object', () => {
    // A value this app never writes — a stale build, or a hand edit.
    store.set(
      KEY,
      JSON.stringify({ theme: 'neon', motion: 'static', depth: 'fast', board: 'walnut' }),
    );
    const loaded = loadSettings();
    expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme);
    // The fields either side of the bad one survive.
    expect(loaded.motion).toBe('static');
    expect(loaded.depth).toBe('fast');
    expect(loaded.board).toBe('walnut');
  });

  it('survives a value that is not JSON at all', () => {
    store.set(KEY, 'not json {');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores fields of the wrong type', () => {
    store.set(KEY, JSON.stringify({ theme: 42, board: null, depth: ['fast'] }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps working when storage itself throws', () => {
    // Private browsing can make setItem throw; a preference that cannot
    // be remembered must still be usable for this session.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('resolveTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes an explicit choice straight through', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('asks the OS only for "system"', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMedia);
    expect(resolveTheme('system')).toBe('dark');
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');

    matchMedia.mockReturnValue({ matches: false });
    expect(resolveTheme('system')).toBe('light');
  });
});
