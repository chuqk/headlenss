import { useEffect, useState } from 'react';
import { useLanguage, type Language, type StringKey } from '../i18n.tsx';

type ClaudeStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';

type Session = {
  name: string;
  created: number;
  windows: number;
  attached: boolean;
  claudeStatus?: ClaudeStatus;
};

function claudeIndicator(status: ClaudeStatus | undefined, t: (key: StringKey) => string): string {
  switch (status) {
    case 'busy': return t('ccBusy');
    case 'idle': return t('ccIdle');
    case 'waiting-permission': return t('ccWaitingPermission');
    case 'waiting-question': return t('ccWaitingQuestion');
    default: return '';
  }
}

export function SessionList({ onOpen }: { onOpen: (name: string) => void }) {
  const { t, language, setLanguage } = useLanguage();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: Session[] };
      setSessions(data.sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Kill session "${name}"?`)) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>headlenss</h1>
        <p className="muted">{t('appSubtitle')}</p>
        <label className="lang-select">
          {t('language')}:
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>
      </header>

      <form className="create-form" onSubmit={create}>
        <input
          type="text"
          placeholder={t('sessionNamePlaceholder')}
          value={newName}
          onChange={(e) => {
            // 再入力されたらカスタムエラーをクリアする
            e.currentTarget.setCustomValidity('');
            setNewName(e.target.value);
          }}
          onInvalid={(e) => e.currentTarget.setCustomValidity(t('sessionNameRule'))}
          pattern="[a-zA-Z0-9_\-]+"
          maxLength={40}
          title={t('sessionNameRule')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit">{t('newSession')}</button>
      </form>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : sessions.length === 0 ? (
        <div className="muted">{t('noSessions')}</div>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => {
            const cc = claudeIndicator(s.claudeStatus, t);
            return (
              <li key={s.name}>
                <button className="session-open" onClick={() => onOpen(s.name)}>
                  <span className="session-name">{s.name}</span>
                  <span className="session-meta">
                    {s.windows} {t(s.windows === 1 ? 'windowUnit' : 'windowUnitPlural')}
                    {s.attached && ` • ${t('attached')}`}
                    {cc && <span className={`cc-indicator cc-${s.claudeStatus}`}> • {cc}</span>}
                  </span>
                </button>
                <button className="session-kill" onClick={() => remove(s.name)} aria-label={`kill ${s.name}`}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
