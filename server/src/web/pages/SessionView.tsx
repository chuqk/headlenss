import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// 新WSプロトコル (server/pty.ts と対応):
//   client → server: { type: 'attach', cols, rows } / { type: 'input', data } /
//                    { type: 'resize', cols, rows } / { type: 'refresh' }
//   server → client: { type: 'screen', serialized } / { type: 'output', data } /
//                    { type: 'attached', cols, rows } / { type: 'exit', code }

type ServerMsg =
  | { type: 'screen'; serialized: string }
  | { type: 'output'; data: string }
  | { type: 'attached'; cols: number; rows: number }
  | { type: 'exit'; code: number };

export function SessionView({ sessionName, onBack }: { sessionName: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#0e0e10',
        foreground: '#e6e6e6',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // ホイールで履歴を遡っている間は新規出力で勝手に最下部に飛ばないようにする。
    // xterm.js の baseY/viewportY は非同期更新で誤判定するため、ホイール操作だけを信頼。
    let userScrolledUp = false;
    term.attachCustomWheelEventHandler((event) => {
      if (event.deltaY < 0) {
        userScrolledUp = true;
      } else if (event.deltaY > 0) {
        requestAnimationFrame(() => {
          const buf = term.buffer.active;
          if (buf.viewportY >= buf.baseY) userScrolledUp = false;
        });
      }
      return true;
    });

    // Shift+Enter: bracketed paste で改行をペースト扱いに包んで送る (split-end と同じ)。
    //   Claude Code を含む多くの TUI 入力欄が DECSET 2004 を有効にしており、
    //   \x1b[200~ ... \x1b[201~ で囲まれた中身は「ペースト」として扱われ submit されない。
    //   xterm.js は customKeyEventHandler で return false しても直後に Enter のデフォルト
    //   バイト (\r) を別パスから onData に流すケースがあるため、ガード変数で1回だけ握り潰す。
    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey && event.type === 'keydown') {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~\n\x1b[201~' }));
        }
        armSuppress();
        return false;
      }
      return true;
    });

    const sendInput = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    };
    const sendResize = (cols: number, rows: number) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    // customKeyEventHandler が Shift+Enter で `return false` しても、xterm.js の
    // 後続パスで Enter のデフォルト byte (\r) が onData に流れてしまうため、
    // 次の1回だけ \r/\n を握り潰すフラグを介在させる。
    let suppressNextEnter = false;
    let suppressTimer: ReturnType<typeof setTimeout> | null = null;
    const armSuppress = () => {
      suppressNextEnter = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      // 50ms 以内に onData が来なければ抑止解除 (誤抑止防止)
      suppressTimer = setTimeout(() => { suppressNextEnter = false; }, 50);
    };

    const onDataDisp = term.onData((data) => {
      if (suppressNextEnter && (data === '\r' || data === '\n' || data === '\r\n')) {
        suppressNextEnter = false;
        if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
        return;
      }
      suppressNextEnter = false;
      sendInput(data);
    });
    const onResizeDisp = term.onResize(({ cols, rows }) => sendResize(cols, rows));

    const fitAndPushSize = () => {
      try {
        fit.fit();
        sendResize(term.cols, term.rows);
      } catch { /* ignore intermittent layout errors */ }
    };

    const openWs = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/api/sessions/${encodeURIComponent(sessionName)}/pty`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposed) { ws?.close(); return; }
        ws!.send(JSON.stringify({ type: 'attach', cols: term.cols, rows: term.rows }));
        term.focus();
      };

      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg; }
        catch { return; }
        switch (msg.type) {
          case 'screen': {
            // 再接続時 / 初回接続時に画面まるごと復元
            term.reset();
            term.write(msg.serialized, () => {
              if (!userScrolledUp) term.scrollToBottom();
            });
            break;
          }
          case 'output': {
            term.write(msg.data, () => {
              if (!userScrolledUp) term.scrollToBottom();
            });
            break;
          }
          case 'attached':
            // 確定サイズで再フィット
            requestAnimationFrame(() => fitAndPushSize());
            break;
          case 'exit':
            term.write(`\r\n\x1b[33m[session exited: ${msg.code}]\x1b[0m\r\n`);
            break;
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        term.write('\r\n\x1b[31m[disconnected — retrying…]\x1b[0m\r\n');
        reconnectTimer = setTimeout(() => { if (!disposed) openWs(); }, 1500);
      };

      ws.onerror = () => {
        // onclose が続けて呼ばれるので再接続はそちらで
      };
    };

    openWs();

    const onWindowResize = () => fitAndPushSize();
    window.addEventListener('resize', onWindowResize);
    const ro = new ResizeObserver(() => fitAndPushSize());
    ro.observe(container);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('resize', onWindowResize);
      ro.disconnect();
      onDataDisp.dispose();
      onResizeDisp.dispose();
      ws?.close();
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
