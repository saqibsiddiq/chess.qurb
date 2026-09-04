import type { RemoteProvider } from './gameImport';

// Re-typing a username on every visit is friction with no purpose: the
// account doesn't change, only the games do. Remembering it means Connect
// can go straight to a refreshed list.

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
    // Stored values are read back into a fetch URL, so they are validated
    // rather than trusted — a corrupted entry should be ignored, not
    // requested.
    if (parsed.provider !== 'lichess' && parsed.provider !== 'chesscom') return null;
    if (typeof parsed.username !== 'string' || !parsed.username.trim()) return null;
    return { provider: parsed.provider, username: parsed.username.trim() };
  } catch {
    // Private mode, disabled storage, or malformed JSON.
    return null;
  }
}

export function saveAccount(account: SavedAccount): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
  } catch {
    // Not remembering is a smaller problem than failing to connect.
  }
}

export function forgetAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}
