import { useState } from 'react';
import { fetchRemoteGames, type RemoteGameSummary, type RemoteProvider } from '../lib/gameImport';

interface ConnectPanelProps {
  onImport: (pgn: string) => void;
}

type Stage = 'closed' | 'picker' | 'username' | 'list';

const PROVIDER_LABEL: Record<RemoteProvider, string> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
};

export default function ConnectPanel({ onImport }: ConnectPanelProps) {
  const [stage, setStage] = useState<Stage>('closed');
  const [provider, setProvider] = useState<RemoteProvider | null>(null);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<RemoteGameSummary[]>([]);

  const reset = () => {
    setStage('closed');
    setProvider(null);
    setUsername('');
    setLoading(false);
    setError(null);
    setGames([]);
  };

  const pickProvider = (p: RemoteProvider) => {
    setProvider(p);
    setStage('username');
    setError(null);
  };

  const fetchGames = async () => {
    if (!provider || !username.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const results = await fetchRemoteGames(provider, username.trim());
      setGames(results);
      setStage('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (stage === 'closed') {
    return (
      <button type="button" className="connect-button" onClick={() => setStage('picker')}>
        Connect <span>⇄</span>
      </button>
    );
  }

  return (
    <div className="connect-panel">
      <div className="connect-panel-header">
        <span className="eyebrow">
          {stage === 'picker' && 'Connect an account'}
          {stage === 'username' && provider && `Connect ${PROVIDER_LABEL[provider]}`}
          {stage === 'list' && provider && `${PROVIDER_LABEL[provider]} games`}
        </span>
        <button type="button" className="connect-close" aria-label="Close" onClick={reset}>
          ✕
        </button>
      </div>

      {stage === 'picker' && (
        <div className="connect-provider-row">
          <button type="button" className="connect-provider-btn" onClick={() => pickProvider('lichess')}>
            Lichess
          </button>
          <button type="button" className="connect-provider-btn" onClick={() => pickProvider('chesscom')}>
            Chess.com
          </button>
        </div>
      )}

      {stage === 'username' && provider && (
        <form
          className="connect-username-row"
          onSubmit={(e) => {
            e.preventDefault();
            fetchGames();
          }}
        >
          <input
            type="text"
            autoFocus
            placeholder={`Your ${PROVIDER_LABEL[provider]} username`}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button type="submit" className="connect-fetch-btn" disabled={loading || !username.trim()}>
            {loading ? 'Looking…' : 'Show games'}
          </button>
        </form>
      )}

      {error && <div className="connect-error">{error}</div>}

      {stage === 'list' && (
        <div className="connect-game-list">
          {games.map((g) => (
            <button
              type="button"
              key={g.id}
              className="connect-game-item"
              onClick={() => {
                onImport(g.pgn);
                reset();
              }}
            >
              <span className="connect-game-players">
                {g.white}
                {g.whiteRating != null && <span className="connect-game-rating"> ({g.whiteRating})</span>} vs {g.black}
                {g.blackRating != null && <span className="connect-game-rating"> ({g.blackRating})</span>}
              </span>
              <span className="connect-game-meta">
                {g.result} · {g.date}
                {g.timeControl && ` · ${g.timeControl}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
