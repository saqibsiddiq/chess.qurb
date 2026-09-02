import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fetchRemoteGames, type RemoteGameSummary, type RemoteProvider } from '../lib/gameImport';
import type { ReviewSummary } from '../lib/storage';
import { insightsFor } from '../lib/insights';
import {
  IconBack,
  IconChevronRight,
  IconFolder,
  IconGlobe,
  IconLibrary,
  IconPaste,
  IconSearch,
  IconUpload,
} from './icons';

interface PgnFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  modified: number;
  games: number | null;
  white: string | null;
  black: string | null;
  date: string | null;
}

interface HomeFlowProps {
  onImport: (pgn: string) => void;
  recent: ReviewSummary[];
  onOpenRecent: (id: string) => void;
}

type Route = 'root' | 'connect' | 'provider' | 'local' | 'browse' | 'paste' | 'library';

const PROVIDER_LABEL: Record<RemoteProvider, string> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
};

const TITLES: Record<Route, string> = {
  root: '',
  connect: 'Connect an account',
  provider: '',
  local: 'Open a local game',
  browse: 'PGN files on this device',
  paste: 'Paste notation',
  library: 'Games you have reviewed',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(epochSeconds: number): string {
  if (!epochSeconds) return '';
  const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/// Below this, a "pattern" is just noise — one or two games say nothing
/// about how somebody habitually plays, and presenting it as a trend
/// would be a lie dressed up as data.
const MIN_GAMES_FOR_INSIGHTS = 3;

export default function HomeFlow({ onImport, recent, onOpenRecent }: HomeFlowProps) {
  // Derived from the summary index alone, so this costs a pass over a
  // handful of small objects rather than loading any stored game.
  const insights = useMemo(() => insightsFor(recent), [recent]);

  const [route, setRoute] = useState<Route>('root');
  const [provider, setProvider] = useState<RemoteProvider | null>(null);

  const [username, setUsername] = useState('');
  const [games, setGames] = useState<RemoteGameSummary[]>([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [files, setFiles] = useState<PgnFile[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const go = (next: Route) => {
    setError(null);
    setRoute(next);
  };

  const back = () => {
    if (route === 'provider') return go('connect');
    if (route === 'browse' || route === 'paste') return go('local');
    go('root');
  };

  /* ── Local files ────────────────────────────────────────────────
     Scanned once per visit to Browse: the answer changes rarely and a
     re-walk on every keystroke elsewhere would be wasted work. */
  const scan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const found = await invoke<PgnFile[]>('scan_pgn_files');
      setFiles(found);
    } catch (err) {
      // Outside the desktop shell there is no filesystem to scan; the
      // file picker below still works, so this is a note, not a failure.
      setScanError(String(err));
      setFiles([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (route === 'browse' && files === null && !scanning) void scan();
  }, [route, files, scanning, scan]);

  useEffect(() => {
    if (route === 'paste') pasteRef.current?.focus();
  }, [route]);

  const openFile = async (file: PgnFile) => {
    try {
      const pgn = await invoke<string>('read_pgn_file', { path: file.path });
      onImport(pgn);
    } catch (err) {
      setScanError(String(err));
    }
  };

  const readLocalFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onImport(reader.result);
    };
    reader.readAsText(file);
  };

  const fetchGames = async () => {
    if (!provider || !username.trim()) return;
    setLoadingGames(true);
    setError(null);
    try {
      setGames(await fetchRemoteGames(provider, username.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingGames(false);
    }
  };

  const showBack = route !== 'root';

  return (
    <div className="home">
      <div className="home-panel">
        <header className="home-head">
          {showBack ? (
            <button type="button" className="icon-btn" onClick={back} aria-label="Back">
              <IconBack />
            </button>
          ) : (
            <span className="home-head-spacer" />
          )}
          <span className="home-head-title">
            {route === 'provider' && provider ? PROVIDER_LABEL[provider] : TITLES[route]}
          </span>
          <span className="home-head-spacer" />
        </header>

        {/* `key` restarts the enter animation on every step, which is what
            makes the flow read as navigation rather than a redraw. */}
        <div className="home-step" key={route}>

          {route === 'root' && (
            <>
              <div className="home-intro">
                <h1 className="home-title">Review your games<br />like a Grandmaster</h1>
                <p className="home-sub">Real Stockfish, running on this machine.</p>
              </div>

              <div className="choice-grid">
                <button type="button" className="choice" onClick={() => go('connect')}>
                  <span className="choice-icon is-connect"><IconGlobe /></span>
                  <span className="choice-body">
                    <span className="choice-title">Connect</span>
                    <span className="choice-sub">Pull recent games from your account</span>
                  </span>
                  <IconChevronRight className="choice-arrow" />
                </button>

                <button type="button" className="choice" onClick={() => go('local')}>
                  <span className="choice-icon is-local"><IconFolder /></span>
                  <span className="choice-body">
                    <span className="choice-title">Local</span>
                    <span className="choice-sub">Open a PGN from this device</span>
                  </span>
                  <IconChevronRight className="choice-arrow" />
                </button>

                {recent.length > 0 && (
                  <button type="button" className="choice" onClick={() => go('library')}>
                    <span className="choice-icon is-library"><IconLibrary /></span>
                    <span className="choice-body">
                      <span className="choice-title">Reviewed</span>
                      <span className="choice-sub">
                        {recent.length} game{recent.length === 1 ? '' : 's'} you have already analysed
                      </span>
                    </span>
                    <IconChevronRight className="choice-arrow" />
                  </button>
                )}
              </div>
            </>
          )}

          {route === 'connect' && (
            <div className="choice-grid">
              <button
                type="button"
                className="choice"
                onClick={() => { setProvider('lichess'); go('provider'); }}
              >
                <span className="choice-icon"><IconGlobe /></span>
                <span className="choice-body">
                  <span className="choice-title">Lichess</span>
                  <span className="choice-sub">lichess.org</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>

              <button
                type="button"
                className="choice"
                onClick={() => { setProvider('chesscom'); go('provider'); }}
              >
                <span className="choice-icon"><IconGlobe /></span>
                <span className="choice-body">
                  <span className="choice-title">Chess.com</span>
                  <span className="choice-sub">chess.com</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>
            </div>
          )}

          {route === 'provider' && provider && (
            <>
              <form
                className="field-row"
                onSubmit={(e) => { e.preventDefault(); void fetchGames(); }}
              >
                <input
                  className="field"
                  type="text"
                  autoFocus
                  placeholder={`Your ${PROVIDER_LABEL[provider]} username`}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={loadingGames || !username.trim()}
                >
                  {loadingGames ? 'Looking…' : 'Find games'}
                </button>
              </form>

              {error && <p className="notice">{error}</p>}

              {games.length > 0 && (
                <ul className="row-list">
                  {games.map((g) => (
                    <li key={g.id}>
                      <button type="button" className="row" onClick={() => onImport(g.pgn)}>
                        <span className="row-main">
                          <span className="row-title">
                            {g.white}
                            {g.whiteRating != null && <span className="row-dim"> {g.whiteRating}</span>}
                            {' vs '}
                            {g.black}
                            {g.blackRating != null && <span className="row-dim"> {g.blackRating}</span>}
                          </span>
                          <span className="row-meta">
                            {g.result} · {g.date}
                            {g.timeControl ? ` · ${g.timeControl}` : ''}
                          </span>
                        </span>
                        <IconChevronRight className="row-arrow" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {route === 'local' && (
            <div className="choice-grid">
              <button type="button" className="choice" onClick={() => go('browse')}>
                <span className="choice-icon"><IconSearch /></span>
                <span className="choice-body">
                  <span className="choice-title">Browse</span>
                  <span className="choice-sub">Find the PGN files already on this device</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>

              <button type="button" className="choice" onClick={() => go('paste')}>
                <span className="choice-icon"><IconPaste /></span>
                <span className="choice-body">
                  <span className="choice-title">Paste</span>
                  <span className="choice-sub">Drop in notation from anywhere</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>
            </div>
          )}

          {route === 'browse' && (
            <>
              {scanning && (
                <ul className="row-list">
                  {[0, 1, 2, 3].map((i) => (
                    <li key={i}><span className="row row-skeleton" /></li>
                  ))}
                </ul>
              )}

              {!scanning && files && files.length > 0 && (
                <ul className="row-list">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button type="button" className="row" onClick={() => void openFile(f)}>
                        <span className="row-main">
                          <span className="row-title">{f.name}</span>
                          <span className="row-meta">
                            {f.white && f.black ? `${f.white} vs ${f.black} · ` : ''}
                            {f.games !== null ? `${f.games} game${f.games === 1 ? '' : 's'} · ` : ''}
                            {f.folder} · {formatSize(f.size)} · {formatWhen(f.modified)}
                          </span>
                        </span>
                        <IconChevronRight className="row-arrow" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {!scanning && files && files.length === 0 && (
                <p className="empty-note">
                  {scanError
                    ? 'File scanning is only available in the desktop app.'
                    : 'No PGN files found in Downloads, Documents or Desktop.'}
                </p>
              )}

              <label className="file-drop">
                <span className="file-drop-icon"><IconUpload /></span>
                <span className="file-drop-body">
                  <span className="row-title">Choose a file instead</span>
                  <span className="row-meta">Pick any .pgn from your device</span>
                </span>
                <input
                  type="file"
                  accept=".pgn,text/plain"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readLocalFile(file);
                  }}
                />
              </label>
            </>
          )}

          {route === 'library' && (
            <>
              {insights && insights.games >= MIN_GAMES_FOR_INSIGHTS && (
                <div className="patterns">
                  <p className="section-label">
                    Your patterns · {insights.player}
                  </p>
                  <div className="insight-stats">
                    <span className="insight-stat">
                      <b className="num">{insights.averageAccuracy.toFixed(0)}%</b> accuracy
                    </span>
                    <span className="insight-stat">
                      <b className="num">{insights.perGame.blunder.toFixed(1)}</b> blunders/game
                    </span>
                    <span className="insight-stat">
                      <b className="num">{insights.wins}–{insights.draws}–{insights.losses}</b> W/D/L
                    </span>
                  </div>
                  {insights.weaknesses.length > 0 && (
                    <ul className="weakness-list">
                      {insights.weaknesses.slice(0, 3).map((w) => (
                        <li key={w.motif} className="weakness">
                          <span className="weakness-label">{w.label}</span>
                          <span className="weakness-rate num">
                            {w.perGame >= 0.1 ? `${w.perGame.toFixed(1)}x/game` : `${w.count} total`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <ul className="row-list">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="row" onClick={() => onOpenRecent(r.id)}>
                      <span className="row-main">
                        <span className="row-title">{r.white} vs {r.black}</span>
                        <span className="row-meta">
                          {r.result} · {r.moveCount} moves · {r.whiteAccuracy.toFixed(0)}% / {r.blackAccuracy.toFixed(0)}%
                        </span>
                      </span>
                      <IconChevronRight className="row-arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {route === 'paste' && (
            <>
              <textarea
                ref={pasteRef}
                className="paste-area"
                rows={9}
                placeholder={'[Event "…"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 …'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={!text.trim()}
                onClick={() => onImport(text.trim())}
              >
                Review this game
              </button>
            </>
          )}
        </div>
      </div>

    </div>
  );
}
