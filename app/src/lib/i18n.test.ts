import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanguageUnavailableError, setLanguage, t, currentLanguage } from './i18n';

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

describe('translation lookup', () => {
  beforeEach(() => { stubStorage(); });
  afterEach(async () => {
    await setLanguage('en');
    vi.unstubAllGlobals();
  });

  it('returns the English text for a known key', () => {
    expect(t('settings.appearance')).toBe('Appearance');
  });

  it('fills placeholders from params', () => {
    expect(t('review.reviewing', { percent: 42 })).toBe('Reviewing 42%');
    expect(t('connect.username', { provider: 'Lichess' })).toBe('Your Lichess username');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    expect(t('review.reviewing')).toContain('{percent}');
  });

  it('returns the key itself when nothing has that key', () => {
    expect(t('nope.not.a.key')).toBe('nope.not.a.key');
  });
});

describe('switching language', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = stubStorage(); });
  afterEach(async () => {
    await setLanguage('en');
    vi.unstubAllGlobals();
  });

  it('downloads a pack once and serves the rest from cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'settings.appearance': 'Apariencia' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await setLanguage('es');
    expect(currentLanguage()).toBe('es');
    expect(t('settings.appearance')).toBe('Apariencia');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await setLanguage('en');
    await setLanguage('es');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has('chesy.locale.es')).toBe(true);
  });

  it('falls back to English for keys a pack does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'settings.appearance': 'Apariencia' }),
    }));
    await setLanguage('es');
    expect(t('settings.appearance')).toBe('Apariencia');
    expect(t('settings.board')).toBe('Board');
  });

  it('keeps the working language when a download fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(setLanguage('fr')).rejects.toBeInstanceOf(LanguageUnavailableError);
    expect(currentLanguage()).toBe('en');
    expect(t('settings.appearance')).toBe('Appearance');
  });

  it('treats a non-200 response as a failure, not as a catalogue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(setLanguage('de')).rejects.toBeInstanceOf(LanguageUnavailableError);
    expect(currentLanguage()).toBe('en');
  });

  it('never goes to the network for English', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await setLanguage('en');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
