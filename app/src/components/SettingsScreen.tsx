import { useState } from 'react';
import type { Settings } from '../lib/settings';
import { LANGUAGES, currentLanguage, setLanguage, useT } from '../lib/i18n';

interface SettingsScreenProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

function Choice<T extends string>({
  label,
  help,
  value,
  options,
  onPick,
}: {
  label: string;
  help: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onPick: (value: T) => void;
}) {
  return (
    <section className="setting">
      <div className="setting-head">
        <h2 className="setting-label">{label}</h2>
        {}
        <p className="setting-help">{help}</p>
      </div>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`segment${o.value === value ? ' is-active' : ''}`}
            aria-pressed={o.value === value}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function SettingsScreen({ settings, onChange }: SettingsScreenProps) {
  const t = useT();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const pickLanguage = async (code: string) => {
    if (code === currentLanguage()) return;
    setPending(code);
    setFailed(false);
    try {
      await setLanguage(code);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="home">
      <div className="home-panel">
        <div className="home-step settings">
          <Choice
            label={t('settings.appearance')}
            help={t('settings.appearance.help')}
            value={settings.theme}
            options={[
              { value: 'system', label: t('settings.appearance.system') },
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
            ]}
            onPick={(v) => set('theme', v)}
          />

          <Choice
            label={t('settings.background')}
            help={t('settings.background.help')}
            value={settings.motion}
            options={[
              { value: 'animated', label: t('settings.background.moving') },
              { value: 'static', label: t('settings.background.still') },
            ]}
            onPick={(v) => set('motion', v)}
          />

          <Choice
            label={t('settings.depth')}
            help={t('settings.depth.help')}
            value={settings.depth}
            options={[
              { value: 'fast', label: t('settings.depth.fast') },
              { value: 'deep', label: t('settings.depth.deep') },
            ]}
            onPick={(v) => set('depth', v)}
          />

          <section className="setting">
            <div className="setting-head">
              <h2 className="setting-label">{t('settings.board')}</h2>
              <p className="setting-help">{t('settings.board.help')}</p>
            </div>
            <div className="board-picker" role="group" aria-label={t('settings.board')}>
              {(['slate', 'classic', 'ocean', 'walnut'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`board-swatch${value === settings.board ? ' is-active' : ''}`}
                  data-swatch={value}
                  aria-pressed={value === settings.board}
                  onClick={() => set('board', value)}
                >
                  {}
                  <span className="swatch-tiles" aria-hidden="true">
                    <span className="swatch-light" />
                    <span className="swatch-dark" />
                  </span>
                  <span className="swatch-name">{t(`settings.board.${value}`)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="setting">
            <div className="setting-head">
              <h2 className="setting-label">{t('settings.language')}</h2>
              <p className="setting-help">{t('settings.language.help')}</p>
            </div>
            <div className="language-list" role="group" aria-label={t('settings.language')}>
              {LANGUAGES.map((l) => {
                const active = l.code === currentLanguage();
                return (
                  <button
                    key={l.code}
                    type="button"
                    className={`language${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    disabled={pending !== null}
                    onClick={() => void pickLanguage(l.code)}
                  >
                    <span className="language-name">{l.label}</span>
                    {}
                    {l.label !== l.english && (
                      <span className="language-english">{l.english}</span>
                    )}
                    {pending === l.code && (
                      <span className="language-state">{t('settings.language.downloading')}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {failed && <p className="notice">{t('settings.language.failed')}</p>}
          </section>

          <p className="setting-note">{t('settings.privacy')}</p>
        </div>
      </div>
    </div>
  );
}
