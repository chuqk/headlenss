import { useEffect, useState } from 'react';
import { SessionList } from './pages/SessionList.tsx';
import { SessionView } from './pages/SessionView.tsx';

type Route = { name: 'list' } | { name: 'session'; sessionName: string };

function getRoute(): Route {
  const m = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (m) return { name: 'session', sessionName: decodeURIComponent(m[1]) };
  return { name: 'list' };
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

  if (route.name === 'session') {
    return <SessionView sessionName={route.sessionName} onBack={() => navigate('/')} />;
  }
  return <SessionList onOpen={(name) => navigate(`/sessions/${encodeURIComponent(name)}`)} />;
}
