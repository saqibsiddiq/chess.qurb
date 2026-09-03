import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * The app's downloadable parts.
 *
 * Stockfish's two neural networks are 107MB of a 109MB engine, so they
 * are not in the package — the app is a tenth of its old size and fetches
 * them once, on first run. The same mechanism is what will deliver a
 * newer engine network, the language model's weights, and language packs
 * later: the app asks a published manifest what it should have, compares
 * that against what is on disk, and downloads the difference. Nothing
 * fetched is ever executed; see `src-tauri/src/assets.rs`.
 */
export interface AssetState {
  name: string;
  version: string;
  bytes: number;
  required: boolean;
  /** On disk, at the version the manifest asks for. */
  installed: boolean;
  /** On disk, but at an older version. */
  outdated: boolean;
}

export interface AssetProgress {
  name: string;
  received: number;
  total: number;
}

/** Human-readable names. The manifest's identifiers are for the code. */
const TITLES: Record<string, string> = {
  'stockfish-net-big': 'Chess engine brain',
  'stockfish-net-small': 'Quick-look brain',
};

export function assetTitle(name: string): string {
  return TITLES[name] ?? name;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface AssetsView {
  /** Null until the first status check answers. */
  assets: AssetState[] | null;
  /** Required assets that are missing or out of date. */
  missing: AssetState[];
  /** Total download size for everything in `missing`. */
  missingBytes: number;
  /** Optional assets with a newer version available. */
  updates: AssetState[];
  downloading: string | null;
  progress: AssetProgress | null;
  error: string | null;
  /** Downloads everything required that is not already installed. */
  install: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Tracks what the app has and what it still needs.
 *
 * A failed status check reports as "nothing installed" rather than as an
 * error: the honest answer offline on a first run is that the engine's
 * networks are not there yet, and saying so leads the user somewhere.
 */
export function useAssets(): AssetsView {
  const [assets, setAssets] = useState<AssetState[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssetProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAssets(await invoke<AssetState[]>('asset_status'));
    } catch (cause) {
      // Outside Tauri — the browser harness — there is no engine to feed,
      // so an empty list is the truthful answer and keeps the dev server
      // usable.
      console.warn('Could not read asset status:', cause);
      setAssets([
        { name: 'stockfish-net-big', version: 'x', bytes: 108919594, required: true, installed: false, outdated: false },
        { name: 'stockfish-net-small', version: 'x', bytes: 3519630, required: true, installed: false, outdated: false },
      ]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const stop = listen<AssetProgress>('asset-progress', (event) =>
      setProgress(event.payload),
    );
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const missing = (assets ?? []).filter((a) => a.required && !a.installed);
  const updates = (assets ?? []).filter((a) => !a.required && a.outdated);

  const install = useCallback(async () => {
    setError(null);
    const wanted = (assets ?? []).filter((a) => a.required && !a.installed);
    for (const asset of wanted) {
      setDownloading(asset.name);
      setProgress({ name: asset.name, received: 0, total: asset.bytes });
      try {
        await invoke('download_asset', { name: asset.name });
      } catch (cause) {
        // Stop at the first failure rather than carrying on: the later
        // downloads are larger, and a user on a bad connection should be
        // told once, not several times.
        setError(String(cause));
        break;
      } finally {
        setDownloading(null);
        setProgress(null);
      }
    }
    await refresh();
  }, [assets, refresh]);

  return {
    assets,
    missing,
    missingBytes: missing.reduce((sum, a) => sum + a.bytes, 0),
    updates,
    downloading,
    progress,
    error,
    install,
    refresh,
  };
}
