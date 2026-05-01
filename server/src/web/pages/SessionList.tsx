import { useEffect, useState } from 'react';

type Session = {
  name: string;
  created: number;
  windows: number;
  attached: boolean;
};

export function SessionList({ onOpen }: { onOpen: (name: string) => void }) {
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
        <p className="muted">tmux sessions</p>
      </header>

      <form className="create-form" onSubmit={create}>
        <input
          type="text"
          placeholder="session name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          pattern="[a-zA-Z0-9_\-]+"
          maxLength={40}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit">+ new</button>
      </form>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="muted">loading...</div>
      ) : sessions.length === 0 ? (
        <div className="muted">no sessions yet</div>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.name}>
              <button className="session-open" onClick={() => onOpen(s.name)}>
                <span className="session-name">{s.name}</span>
                <span className="session-meta">
                  {s.windows} window{s.windows === 1 ? '' : 's'}
                  {s.attached && ' • attached'}
                </span>
              </button>
              <button className="session-kill" onClick={() => remove(s.name)} aria-label={`kill ${s.name}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
