import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fetchRemoteGames, type RemoteGameSummary, type RemoteProvider } from '../lib/gameImport';
import type { ReviewSummary } from '../lib/storage';
import type { LichessAnalysisEntry } from '../lib/lichessAnalysis';
import { insightsFor } from '../lib/insights';
import { forgetAccount, loadAccount, saveAccount } from '../lib/account';
import { TERMINATION_LABELS, type Termination } from '../lib/termination';
import { openingRecords } from '../lib/openings';
import { useT } from '../lib/i18n';
import { accuracyTone, scoreTone, blunderTone } from '../lib/tone';
import {
  IconChevronRight,
  IconFolder,
  IconChessCom,
  IconGlobe,
  IconLichess,
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
  /** `analysis`, when the source already has one, lets the review skip
   *  the local engine entirely. */
  onImport: (pgn: string, analysis?: LichessAnalysisEntry[]) => void;
  recent: ReviewSummary[];
  onOpenRecent: (id: string) => void;
  /** Lifts the current step up to the shell so there is one top bar for
   *  the whole app rather than a second one nested inside this panel.
   *  `onBack` is null on the first screen, which is what tells the shell
   *  to show the logo instead of a back button. */
  onNav?: (nav: {
    title: string;
    onBack: (() => void) | null;
    /** When set, the title names something you can act on — the connected
     *  account — and the shell renders it as a control rather than a
     *  label. Keeping it out of the page body is what leaves the whole
     *  screen for the games. */
    onTitleTap?: (() => void) | null;
  }) => void;
}

type Route = 'root' | 'connect' | 'provider' | 'local' | 'browse' | 'paste' | 'library' | 'stats' | 'opening';

const PROVIDER_LABEL: Record<RemoteProvider, string> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
};

/** Routes with no title of their own: the first screen, and the provider
 *  screen whose title is the connected account's name. */
const UNTITLED: ReadonlySet<Route> = new Set(['root', 'provider']);

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

export default function HomeFlow({ onImport, recent, onOpenRecent, onNav }: HomeFlowProps) {
  const tr = useT();
  // Derived from the summary index alone, so this costs a pass over a
  // handful of small objects rather than loading any stored game.
  const insights = useMemo(() => insightsFor(recent), [recent]);

  // Grouped from the same summary index the patterns use, so this costs
  // nothing extra.
  const openings = useMemo(
    () => (insights ? openingRecords(recent, insights.player).slice(0, 6) : []),
    [recent, insights],
  );

  const [route, setRoute] = useState<Route>('root');
  const [provider, setProvider] = useState<RemoteProvider | null>(null);

  const [username, setUsername] = useState('');
  const [games, setGames] = useState<RemoteGameSummary[]>([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Username we are connected as for the current provider, or null.
   *  Kept in state rather than read from storage at render time so the
   *  connected view appears the moment a first sign-in succeeds, not on
   *  the next visit. */
  const [connected, setConnected] = useState<string | null>(null);

  const [files, setFiles] = useState<PgnFile[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [openOpening, setOpenOpening] = useState<string | null>(null);
  const [text, setText] = useState('');
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const go = (next: Route) => {
    setError(null);
    setRoute(next);
  };

  const back = () => {
    if (route === 'provider') return go('connect');
    if (route === 'browse' || route === 'paste') return go('local');
    if (route === 'stats') return go('library');
    if (route === 'opening') return go('stats');
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

  const fetchGames = useCallback(
    async (forProvider: RemoteProvider, forUsername: string) => {
      const name = forUsername.trim();
      if (!name) return;
      setLoadingGames(true);
      setError(null);
      try {
        const found = await fetchRemoteGames(forProvider, name);
        setGames(found);
        // Only remembered once it actually worked — storing a typo would
        // make every future visit start with a failing request.
        saveAccount({ provider: forProvider, username: name });
        setConnected(name);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingGames(false);
      }
    },
    [],
  );

  /** Provider whose games this visit has already asked for. Without it a
   *  failed request would re-fire the effect the moment `loadingGames`
   *  went false — games would still be empty, so the condition would hold
   *  again — and the account would sit in a silent retry loop. */
  const autoFetched = useRef<RemoteProvider | null>(null);

  // A remembered account skips straight to a refreshed list: the account
  // doesn't change between visits, only the games do.
  //
  // Deliberately not gated on `username` being empty. `openProvider`
  // fills the username in from storage before switching route, so a
  // `!username` guard here is false on the very first render and the
  // fetch never runs at all — which is what made a connected account show
  // an empty list under a search box.
  useEffect(() => {
    if (route !== 'provider' || !provider) return;
    if (games.length > 0 || loadingGames) return;
    if (autoFetched.current === provider) return;
    const saved = loadAccount();
    if (saved && saved.provider === provider) {
      autoFetched.current = provider;
      void fetchGames(provider, saved.username);
    }
  }, [route, provider, games.length, loadingGames, fetchGames]);

  const openProvider = (next: RemoteProvider) => {
    const saved = loadAccount();
    setProvider(next);
    // Clear any list from the other provider so the remembered account
    // for *this* one can load in its place.
    setGames([]);
    const known = saved?.provider === next ? saved.username : '';
    setUsername(known);
    setConnected(known || null);
    autoFetched.current = null;
    go('provider');
  };

  const switchAccount = () => {
    forgetAccount();
    setUsername('');
    setGames([]);
    setError(null);
    setConnected(null);
    autoFetched.current = null;
  };

  const isRoot = route === 'root';
  // On a connected provider the screen is about the account, not the
  // site, so the account's name is the title.
  const stepTitle =
    route === 'provider' && provider
      ? connected ?? PROVIDER_LABEL[provider]
      : UNTITLED.has(route)
        ? ''
        : tr(`nav.${route}`);
  const titleActs = route === 'provider' && !!connected;

  useEffect(() => {
    onNav?.({
      title: stepTitle,
      onBack: isRoot ? null : back,
      onTitleTap: titleActs ? switchAccount : null,
    });
    // `back` is redefined every render; depending on it would report on
    // every render instead of every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, stepTitle, isRoot, titleActs, onNav]);

  return (
    <div className="home">
      <div className={`home-panel${isRoot ? ' is-root' : ''}`}>
        {/* `key` restarts the enter animation on every step, which is what
            makes the flow read as navigation rather than a redraw. */}
        <div className="home-step" key={route}>

          {route === 'root' && (
            <>
              <div className="home-intro">
                <h1 className="home-title">{tr('home.title')}</h1>
                <p className="home-sub">{tr('home.subtitle')}</p>
              </div>

              <div className="choice-grid">
                <button type="button" className="choice" onClick={() => go('connect')}>
                  <span className="choice-icon is-connect"><IconGlobe /></span>
                  <span className="choice-body">
                    <span className="choice-title">{tr('home.connect')}</span>
                    <span className="choice-sub">{tr('home.connect.sub')}</span>
                  </span>
                  <IconChevronRight className="choice-arrow" />
                </button>

                <button type="button" className="choice" onClick={() => go('local')}>
                  <span className="choice-icon is-local"><IconFolder /></span>
                  <span className="choice-body">
                    <span className="choice-title">{tr('home.local')}</span>
                    <span className="choice-sub">{tr('home.local.sub')}</span>
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
                onClick={() => openProvider('lichess')}
              >
                <span className="choice-icon is-lichess"><IconLichess /></span>
                <span className="choice-body">
                  <span className="choice-title">Lichess</span>
                  <span className="choice-sub">lichess.org</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>

              <button
                type="button"
                className="choice"
                onClick={() => openProvider('chesscom')}
              >
                <span className="choice-icon is-chesscom"><IconChessCom /></span>
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
              {/* The account is named in the top bar, and switching is a
                  tap on that name — so this screen is nothing but games.
                  A remembered account never sees a search box: asking for
                  the username again reads as "we lost you". */}
              {connected ? null : (
                <form
                  className="field-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void fetchGames(provider, username);
                  }}
                >
                  <input
                    className="field"
                    type="text"
                    autoFocus
                    placeholder={tr('connect.username', { provider: PROVIDER_LABEL[provider] })}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={loadingGames || !username.trim()}
                  >
                    {loadingGames ? tr('connect.looking') : tr('connect.find')}
                  </button>
                </form>
              )}

              {error && <p className="notice">{error}</p>}

              {games.length > 0 && (
                <ul className="row-list">
                  {games.map((g, i) => (
                    <li key={g.id}>
                      <button type="button" className="row" onClick={() => onImport(g.pgn, g.analysis)}>
                        {/* Newest first, so the number is a position in the
                            list rather than a game id — it is there to keep
                            your place while scrolling a hundred rows. */}
                        <span className="row-no num">{i + 1}</span>
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
                  <span className="choice-title">{tr('local.browse')}</span>
                  <span className="choice-sub">{tr('local.browse.sub')}</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>

              <button type="button" className="choice" onClick={() => go('paste')}>
                <span className="choice-icon"><IconPaste /></span>
                <span className="choice-body">
                  <span className="choice-title">{tr('local.paste')}</span>
                  <span className="choice-sub">{tr('local.paste.sub')}</span>
                </span>
                <IconChevronRight className="choice-arrow" />
              </button>
            </div>
          )}

          {route === 'browse' && (
            <>
              {/* A line, not skeleton rows. The placeholders were built
                  before rows became glass buttons; once they inherited
                  that chrome they read as three broken, empty controls
                  rather than as "loading". */}
              {scanning && <p className="empty-note">{tr('local.scanning')}</p>}

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
                    ? tr('local.scanOnlyDesktop')
                    : tr('local.noFiles')}
                </p>
              )}

              <label className="file-drop">
                <span className="file-drop-icon"><IconUpload /></span>
                <span className="file-drop-body">
                  <span className="row-title">{tr('local.chooseFile')}</span>
                  <span className="row-meta">{tr('local.chooseFile.sub')}</span>
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
                <button type="button" className="choice" onClick={() => go('stats')}>
                  <span className="choice-icon is-library"><IconLibrary /></span>
                  <span className="choice-body">
                    <span className="choice-title">How you have been playing</span>
                    <span className="choice-sub">
                      Your habits and openings across {insights.games} games
                    </span>
                  </span>
                  <IconChevronRight className="choice-arrow" />
                </button>
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

          {route === 'stats' && insights && (
            <>
              {/* Written for someone who has never seen an engine report:
                  every number says what it means in the same breath. */}
              <div className="stat-grid">
                <div className={`stat-card is-${accuracyTone(insights.averageAccuracy)}`}>
                  <span className="stat-value num">{insights.averageAccuracy.toFixed(0)}%</span>
                  <span className="stat-name">{tr('stats.accuracy')}</span>
                  <span className="stat-help">
                    How close your moves were to the best available. 100% would be perfect play.
                  </span>
                </div>
                <div className={`stat-card is-${blunderTone(insights.perGame.blunder)}`}>
                  <span className="stat-value num">{insights.perGame.blunder.toFixed(1)}</span>
                  <span className="stat-name">{tr('stats.blunders')}</span>
                  <span className="stat-help">
                    Moves that threw away a serious amount. Fewer is better.
                  </span>
                </div>
                <div className={`stat-card is-${scoreTone(((insights.wins + insights.draws * 0.5) / Math.max(1, insights.games)) * 100)}`}>
                  <span className="stat-value num">
                    {insights.wins}–{insights.draws}–{insights.losses}
                  </span>
                  <span className="stat-name">{tr('stats.record')}</span>
                  <span className="stat-help">Your record across these {insights.games} games.</span>
                </div>
              </div>

              {insights.weaknesses.length > 0 && (
                <>
                  <p className="section-label">{tr('stats.weaknesses')}</p>
                  <ul className="weakness-list">
                    {insights.weaknesses.slice(0, 4).map((w) => (
                      <li key={w.motif} className="weakness">
                        <span className="weakness-label">{w.label}</span>
                        <span className="weakness-rate num">
                          {w.perGame >= 0.1 ? `${w.perGame.toFixed(1)} per game` : `${w.count} times`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {Object.keys(insights.lossesBy).length > 0 && (
                <>
                  <p className="section-label">{tr('stats.losses')}</p>
                  <ul className="weakness-list">
                    {Object.entries(insights.lossesBy)
                      .sort((a, b) => b[1] - a[1])
                      .map(([how, n]) => (
                        <li key={how} className="weakness">
                          <span className="weakness-label">
                            {TERMINATION_LABELS[how as Termination] ?? how}
                          </span>
                          <span className="weakness-rate num">{n}</span>
                        </li>
                      ))}
                  </ul>
                </>
              )}

              {openings.length > 0 && (
                <>
                  <p className="section-label">{tr('stats.openings')}</p>
                  <ul className="row-list">
                    {openings.map((o) => (
                      <li key={o.name}>
                        <button
                          type="button"
                          className={`row is-${scoreTone(o.score * 100)}`}
                          onClick={() => { setOpenOpening(o.name); go('opening'); }}
                        >
                          <span className="row-main">
                            <span className="row-title">{o.name}</span>
                            <span className="row-meta">
                              {o.games} game{o.games === 1 ? '' : 's'} · won{' '}
                              {Math.round(o.score * 100)}% of the points
                              {o.averageBookExit !== null &&
                                ` · followed theory to move ${Math.max(1, Math.round(o.averageBookExit / 2))}`}
                            </span>
                          </span>
                          <IconChevronRight className="row-arrow" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {route === 'opening' && openOpening && (() => {
            const record = openings.find((o) => o.name === openOpening);
            if (!record) return <p className="empty-note">That opening is no longer in your library.</p>;
            return (
              <>
                <div className="opening-head">
                  <h2 className="opening-title">{record.name}</h2>
                  {record.eco && <span className="opening-eco num">{record.eco}</span>}
                </div>

                <div className="stat-grid">
                  <div className="stat-card">
                    <span className="stat-value num">{record.games}</span>
                    <span className="stat-name">{tr('opening.timesPlayed')}</span>
                  </div>
                  <div className={`stat-card is-${scoreTone(record.score * 100)}`}>
                    <span className="stat-value num">{Math.round(record.score * 100)}%</span>
                    <span className="stat-name">{tr('opening.pointsWon')}</span>
                    <span className="stat-help">
                      A win counts 1, a draw counts a half. 50% means you break even.
                    </span>
                  </div>
                  <div className={`stat-card is-${accuracyTone(record.accuracy)}`}>
                    <span className="stat-value num">{record.accuracy.toFixed(0)}%</span>
                    <span className="stat-name">{tr('opening.accuracy')}</span>
                  </div>
                </div>

                <p className="opening-note">
                  {record.wins}&nbsp;won, {record.draws}&nbsp;drawn, {record.losses}&nbsp;lost.
                  {record.averageBookExit !== null && (
                    <>
                      {' '}You usually follow known theory until about move{' '}
                      <strong>{Math.max(1, Math.round(record.averageBookExit / 2))}</strong>, then
                      start playing your own moves. That is the point worth studying next — it is
                      where preparation stops helping you.
                    </>
                  )}
                </p>

                <p className="section-label">What theory is</p>
                <p className="opening-note">
                  Openings have well-trodden paths that strong players have worked out over decades.
                  Following them keeps you on ground others have already tested. Leaving them early
                  is not wrong, but it means you are on your own sooner than your opponent may be.
                </p>
              </>
            );
          })()}

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
