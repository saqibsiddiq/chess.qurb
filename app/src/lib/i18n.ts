import { useSyncExternalStore } from 'react';
import en from '../locales/en.json';

/**
 * The app's translation layer.
 *
 * Deliberately small — no i18n library. What is actually needed here is
 * key lookup, `{placeholder}` interpolation and a fallback chain, and a
 * library that does plurals and formatting for forty locales would cost
 * more bundle than the whole catalogue it serves.
 *
 * A value may be an array as well as a string. Nothing uses that yet, but
 * the move explanations are built from pools of interchangeable phrasings
 * (see `explanationVariants.ts`), and when those are translated they have
 * to land in this same catalogue rather than a second parallel system.
 * Supporting the shape now costs one line and avoids a migration later.
 */
export type CatalogueValue = string | string[];
export type Catalogue = Record<string, CatalogueValue>;

/** Where downloadable packs are published: the project's own Pages site.
 *
 *  The github.io origin rather than the chess.qurb.cloud custom domain,
 *  which has no DNS record yet, so every pack download failed to resolve
 *  and each language other than English reported itself unavailable. This
 *  keeps working if that domain is set up later, since Pages then
 *  redirects here to it. */
const PACK_BASE = 'https://saqibsiddiq.github.io/chess.qurb/locales';
const CACHE_PREFIX = 'chesy.locale.';
const CHOICE_KEY = 'chesy.language';

export interface LanguageOption {
  code: string;
  /** The language's own name, which is what a speaker of it looks for. */
  label: string;
  /** The English name, for anyone who has landed here by accident. */
  english: string;
}

/**
 * Languages the app offers. English is bundled; the rest are fetched.
 *
 * Listing them here rather than fetching an index keeps the picker
 * working offline — a user with no connection still sees what exists and
 * gets a clear failure on the one they pick, instead of an empty screen.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', label: 'English', english: 'English' },
  { code: 'es', label: 'Español', english: 'Spanish' },
  { code: 'hi', label: 'हिन्दी', english: 'Hindi' },
  { code: 'fr', label: 'Français', english: 'French' },
  { code: 'de', label: 'Deutsch', english: 'German' },
  { code: 'pt', label: 'Português', english: 'Portuguese' },
];

const BASE: Catalogue = en as Catalogue;

let code = 'en';
let active: Catalogue = BASE;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Looks up `key`, filling `{placeholders}` from `params`.
 *
 * Falls back through the active catalogue, then English, then the key
 * itself. Returning the key rather than an empty string is deliberate: a
 * missing translation should be obvious in the interface, not invisible.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = active[key] ?? BASE[key] ?? key;
  const text = Array.isArray(raw) ? (raw[0] ?? key) : raw;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function currentLanguage(): string {
  return code;
}

/** The language the user last chose, if it was ever recorded. */
export function savedLanguage(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

function readCache(target: string): Catalogue | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + target);
    return raw ? (JSON.parse(raw) as Catalogue) : null;
  } catch {
    return null;
  }
}

function writeCache(target: string, catalogue: Catalogue): void {
  try {
    localStorage.setItem(CACHE_PREFIX + target, JSON.stringify(catalogue));
  } catch {
    // A pack that cannot be cached still works for this session; it will
    // simply be fetched again next time.
  }
}

export class LanguageUnavailableError extends Error {
  /** Kept as a field rather than `Error.cause`, which needs a newer lib
   *  target than this project compiles against. */
  readonly reason: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'LanguageUnavailableError';
    this.reason = reason;
  }
}

/**
 * Switches language, downloading the pack the first time it is needed.
 *
 * A pack is cached after its first successful download, so a language is
 * fetched once and then works offline like the rest of the app. English
 * never touches the network.
 */
export async function setLanguage(target: string): Promise<void> {
  if (target === 'en') {
    code = 'en';
    active = BASE;
    try { localStorage.setItem(CHOICE_KEY, 'en'); } catch { /* not fatal */ }
    announce();
    return;
  }

  const cached = readCache(target);
  if (cached) {
    code = target;
    active = cached;
    try { localStorage.setItem(CHOICE_KEY, target); } catch { /* not fatal */ }
    announce();
    return;
  }

  let catalogue: Catalogue;
  try {
    const response = await fetch(`${PACK_BASE}/${target}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    catalogue = (await response.json()) as Catalogue;
  } catch (cause) {
    // The caller shows this; the app stays on the language it had rather
    // than dropping to a half-translated state.
    throw new LanguageUnavailableError(
      `Could not download the ${target} language pack.`,
      cause,
    );
  }

  writeCache(target, catalogue);
  code = target;
  active = catalogue;
  try { localStorage.setItem(CHOICE_KEY, target); } catch { /* not fatal */ }
  announce();
}

/** Restores the saved language at startup, silently if it cannot load. */
export async function restoreLanguage(): Promise<void> {
  const saved = savedLanguage();
  if (!saved || saved === 'en') return;
  try {
    await setLanguage(saved);
  } catch {
    // Starting in English beats refusing to start.
  }
}

/**
 * `t` bound to the active language, and re-rendering when it changes.
 *
 * The identity of the returned function changes with the language, which
 * is what makes components using it re-render on a switch.
 */
export function useT(): typeof t {
  const language = useSyncExternalStore(subscribe, currentLanguage, () => 'en');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void language;
  return t;
}
