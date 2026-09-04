import type { RemoteProvider } from './gameImport';

const KEY = 'chesy.account';

export interface SavedAccount {
  provider: RemoteProvider;
  username: string;
}

export function loadAccount(): SavedAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedAccount;
    if (parsed.provider !== 'lichess' && parsed.provider !== 'chesscom') return null;
    if (typeof parsed.username !== 'string' || !parsed.username.trim()) return null;
    return { provider: parsed.provider, username: parsed.username.trim() };
  } catch {
    return null;
  }
}

export function saveAccount(account: SavedAccount): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
  } catch {
  }
}

export function forgetAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
  }
}
