import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { WebSocket } from 'ws';
import { validateName } from './tmux.ts';

type ResizeMsg = { type: 'resize'; cols: number; rows: number };

export function handlePtyConnection(ws: WebSocket, sessionName: string): void {
  try {
    validateName(sessionName);
  } catch (e) {
    ws.close(1008, (e as Error).message);
    return;
  }

  const home = process.env.HOME ?? '/';
  const term = pty.spawn('tmux', ['new-session', '-A', '-c', home, '-s', sessionName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: home,
    env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
  });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text) as ResizeMsg;
          if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            term.resize(msg.cols, msg.rows);
            return;
          }
        } catch {
          // not a JSON control message, fall through
        }
      }
      term.write(text);
    } else {
      term.write(data.toString());
    }
  });

  const cleanup = () => {
    try {
      term.kill();
    } catch {
      // already dead
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
