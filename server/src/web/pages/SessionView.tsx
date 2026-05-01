import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function SessionView({ sessionName, onBack }: { sessionName: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0e0e10',
        foreground: '#e6e6e6',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProto}://${window.location.host}/api/sessions/${encodeURIComponent(sessionName)}/pty`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        // ignore intermittent layout errors
      }
    };
    window.addEventListener('resize', sendResize);
    const ro = new ResizeObserver(sendResize);
    ro.observe(container);

    return () => {
      window.removeEventListener('resize', sendResize);
      ro.disconnect();
      onData.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionName]);

  return (
    <div className="page page-session">
      <header className="session-header">
        <button onClick={onBack} aria-label="back">
          ← back
        </button>
        <span className="session-title">{sessionName}</span>
      </header>
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
