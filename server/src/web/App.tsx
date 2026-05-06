import { useEffect, useState } from 'react';
import { SessionList } from './pages/SessionList.tsx';
import { SessionView } from './pages/SessionView.tsx';
import { ChatView } from './pages/ChatView.tsx';

type Mode = 'tmux' | 'chat';
type Route =
  | { name: 'list' }
  | { name: 'session'; sessionName: string; mode: Mode };

// localStorage 上のセッション別モード設定。
//   { [sessionName]: 'chat'|'tmux', __default?: 'chat'|'tmux' }
// __default は「過去に何かしらモードを選んだことがあるユーザの新セッション初期値」。
const MODES_STORAGE_KEY = 'headlenss.modes';

type ModeMap = { __default?: Mode; [sessionName: string]: Mode | undefined };

function readModeMap(): ModeMap {
  try {
    const raw = localStorage.getItem(MODES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ModeMap;
    return {};
  } catch {
    return {};
  }
}

function writeModeMap(map: ModeMap): void {
  try {
    localStorage.setItem(MODES_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function readModeFromUrl(): Mode | null {
  const m = new URL(window.location.href).searchParams.get('mode');
  return m === 'chat' || m === 'tmux' ? m : null;
}

function readModeFromStorage(sessionName: string): Mode | null {
  const map = readModeMap();
  const v = map[sessionName] ?? map.__default;
  return v === 'chat' || v === 'tmux' ? v : null;
}

/** URL > localStorage[sessionName] > localStorage.__default > tmux の優先順。
 *  URL に mode が無ければ解決した値を URL に書き戻して以後 URL を真実とする
 *  (ブックマーク・共有を確実にするため)。 */
function resolveMode(sessionName: string): Mode {
  const fromUrl = readModeFromUrl();
  if (fromUrl) return fromUrl;
  const fromStorage = readModeFromStorage(sessionName);
  const mode: Mode = fromStorage ?? 'tmux';
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState(null, '', url.toString());
  return mode;
}

function getRoute(): Route {
  const m = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (m) {
    const sessionName = decodeURIComponent(m[1]);
    return {
      name: 'session',
      sessionName,
      mode: resolveMode(sessionName),
    };
  }
  return { name: 'list' };
}

function setMode(sessionName: string, mode: Mode): void {
  const map = readModeMap();
  map[sessionName] = mode;
  // 新セッションを開いた時のフォールバックとして「最後に明示的に選んだモード」も覚えておく
  map.__default = mode;
  writeModeMap(map);
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
    if (route.name !== 'session') return;
    setMode(route.sessionName, mode);
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
