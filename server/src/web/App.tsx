import { useEffect, useState } from 'react';
import { SessionList } from './pages/SessionList.tsx';
import { SessionView } from './pages/SessionView.tsx';
import { ChatView } from './pages/ChatView.tsx';

type Mode = 'tmux' | 'chat';
type Route =
  | { name: 'list' }
  | { name: 'session'; sessionName: string; mode: Mode };

const MODE_STORAGE_KEY = 'headlenss.mode';

function readModeFromUrl(): Mode | null {
  const m = new URL(window.location.href).searchParams.get('mode');
  return m === 'chat' || m === 'tmux' ? m : null;
}

function readModeFromStorage(): Mode | null {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    return v === 'chat' || v === 'tmux' ? v : null;
  } catch {
    return null;
  }
}

/** URL > localStorage > tmux(default) の優先順でモードを決定。
 *  URL に mode が無い場合は localStorage の値を URL にも書き戻して
 *  以後 URL を真実とする(ブックマーク・共有を確実にするため)。 */
function resolveMode(): Mode {
  const fromUrl = readModeFromUrl();
  if (fromUrl) return fromUrl;
  const fromStorage = readModeFromStorage();
  const mode: Mode = fromStorage ?? 'tmux';
  // URL に書き戻す (replaceState なので履歴は増えない)
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState(null, '', url.toString());
  return mode;
}

function getRoute(): Route {
  const m = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (m) {
    return {
      name: 'session',
      sessionName: decodeURIComponent(m[1]),
      mode: resolveMode(),
    };
  }
  return { name: 'list' };
}

function setMode(mode: Mode): void {
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState(null, '', url.toString());
}

export function App() {
  const [route, setRoute] = useState<Route>(getRoute);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState(null, '', path);
    setRoute(getRoute());
  };

  const switchMode = (mode: Mode) => {
    setMode(mode);
    setRoute(getRoute());
  };

  if (route.name === 'session') {
    return route.mode === 'chat' ? (
      <ChatView
        sessionName={route.sessionName}
        onBack={() => navigate('/')}
        onSwitchMode={switchMode}
      />
    ) : (
      <SessionView
        sessionName={route.sessionName}
        onBack={() => navigate('/')}
        onSwitchMode={switchMode}
      />
    );
  }
  return <SessionList onOpen={(name) => navigate(`/sessions/${encodeURIComponent(name)}`)} />;
}
