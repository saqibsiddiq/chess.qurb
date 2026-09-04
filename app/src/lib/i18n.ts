import { useSyncExternalStore } from 'react';
import en from '../locales/en.json';

export type CatalogueValue = string | string[];
export type Catalogue = Record<string, CatalogueValue>;

const PACK_BASE = 'https://saqibsiddiq.github.io/chess.qurb/locales';
const CACHE_PREFIX = 'chesy.locale.';
const CHOICE_KEY = 'chesy.language';

export interface LanguageOption {
  code: string;
  label: string;
  english: string;
}

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
  }
}

export class LanguageUnavailableError extends Error {
  readonly reason: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'LanguageUnavailableError';
    this.reason = reason;
  }
}

export async function setLanguage(target: string): Promise<void> {
  if (target === 'en') {
    code = 'en';
    active = BASE;
    try { localStorage.setItem(CHOICE_KEY, 'en'); } catch {  }
    announce();
    return;
  }

  const cached = readCache(target);
  if (cached) {
    code = target;
    active = cached;
    try { localStorage.setItem(CHOICE_KEY, target); } catch {  }
    announce();
    return;
  }

  let catalogue: Catalogue;
  try {
    const response = await fetch(`${PACK_BASE}/${target}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    catalogue = (await response.json()) as Catalogue;
  } catch (cause) {
    throw new LanguageUnavailableError(
      `Could not download the ${target} language pack.`,
      cause,
    );
  }

  writeCache(target, catalogue);
  code = target;
  active = catalogue;
  try { localStorage.setItem(CHOICE_KEY, target); } catch {  }
  announce();
}

export async function restoreLanguage(): Promise<void> {
  const saved = savedLanguage();
  if (!saved || saved === 'en') return;
  try {
    await setLanguage(saved);
  } catch {
  }
}

export function useT(): typeof t {
  const language = useSyncExternalStore(subscribe, currentLanguage, () => 'en');
  void language;
  return t;
}
