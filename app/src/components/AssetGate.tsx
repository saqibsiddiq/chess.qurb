import { useT } from '../lib/i18n';
import { assetTitle, formatBytes, type AssetsView } from '../lib/assets';

/**
 * First-run download screen.
 *
 * The app ships without the engine's neural networks — they are 107MB of
 * a 109MB engine — so on a fresh install there is one thing to fetch
 * before a game can be reviewed. This screen exists to make that a
 * deliberate, explained step rather than a silent 100MB download on a
 * phone's mobile data.
 */
export default function AssetGate({ assets }: { assets: AssetsView }) {
  const t = useT();
  const { missing, missingBytes, downloading, progress, error, install } = assets;

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0;

  return (
    <main className="home">
      <div className="home-panel">
        <div className="home-step gate glass">
          <h1 className="gate-title">{t('assets.title')}</h1>
          <p className="gate-lede">
            {t('assets.lede', { size: formatBytes(missingBytes) })}
          </p>

          <ul className="gate-list">
            {missing.map((asset) => (
              <li key={asset.name} className="gate-item">
                <span className="gate-item-name">{assetTitle(asset.name)}</span>
                <span className="gate-item-size">{formatBytes(asset.bytes)}</span>
              </li>
            ))}
          </ul>

          {downloading ? (
            <div className="gate-progress">
              {/* A determinate bar, because the size is known up front and
                  a 100MB download over a phone connection is long enough
                  that a spinner would read as a hang. */}
              <div
                className="gate-bar"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={assetTitle(downloading)}
              >
                <span className="gate-bar-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="gate-progress-text">
                {t('assets.downloading', {
                  name: assetTitle(downloading),
                  percent,
                })}
              </p>
            </div>
          ) : (
            <button type="button" className="btn btn-primary btn-block gate-action" onClick={() => void install()}>
              {t('assets.download', { size: formatBytes(missingBytes) })}
            </button>
          )}

          {error && <p className="notice">{t('assets.failed')}</p>}

          <p className="gate-note">{t('assets.note')}</p>
        </div>
      </div>
    </main>
  );
}
