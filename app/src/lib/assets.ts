import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AssetState {
  name: string;
  version: string;
  bytes: number;
  required: boolean;
  installed: boolean;
  outdated: boolean;
}

export interface AssetProgress {
  name: string;
  received: number;
  total: number;
}

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
  assets: AssetState[] | null;
  missing: AssetState[];
  missingBytes: number;
  updates: AssetState[];
  downloading: string | null;
  progress: AssetProgress | null;
  error: string | null;
  install: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAssets(): AssetsView {
  const [assets, setAssets] = useState<AssetState[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssetProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAssets(await invoke<AssetState[]>('asset_status'));
    } catch (cause) {
      console.warn('Could not read asset status:', cause);
      setAssets([]);
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
