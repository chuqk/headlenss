import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import { ensureSession, validateName } from './tmux.ts';

// @xterm/headless / addon-serialize は CJS モジュールで Terminal/SerializeAddon を default export に内包する
const { Terminal: HeadlessTerminal } = headlessPkg as unknown as {
  Terminal: new (opts: { cols: number; rows: number; scrollback: number; allowProposedApi?: boolean }) => HeadlessTerminalInstance;
};
const { SerializeAddon } = serializePkg as unknown as { SerializeAddon: new () => SerializeAddonInstance };

type HeadlessTerminalInstance = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  loadAddon: (addon: unknown) => void;
  dispose: () => void;
};
type SerializeAddonInstance = {
  serialize: () => string;
};

// 設計:
//   tmux Control Mode (-CC) を介して各セッションに 1 本だけ attach し、
//   サーバ側に @xterm/headless の VT100 エミュレータを常駐させる。
//   ・複数のブラウザクライアントが同じセッションを共有可能 (broadcast)
//   ・接続/再接続時は SerializeAddon.serialize() で画面まるごと復元
//   ・各クライアントが独自サイズを持てる (refresh-client -C + resize-window)
//   ・入力は send-keys -H <hex> でバイト直送 (Shift+Enter 等の拡張キーも正確に届く)
//   ・tmux mouse off で Web UI 側の xterm.js scrollback が効くようになる

interface ClientMsgAttach { type: 'attach'; cols?: number; rows?: number }
interface ClientMsgInput { type: 'input'; data: string }
interface ClientMsgResize { type: 'resize'; cols: number; rows: number }
interface ClientMsgRefresh { type: 'refresh' }
type ClientMsg = ClientMsgAttach | ClientMsgInput | ClientMsgResize | ClientMsgRefresh;

interface ServerMsgOutput { type: 'output'; data: string }
interface ServerMsgScreen { type: 'screen'; serialized: string }
interface ServerMsgAttached { type: 'attached'; cols: number; rows: number }
interface ServerMsgExit { type: 'exit'; code: number }
type ServerMsg = ServerMsgOutput | ServerMsgScreen | ServerMsgAttached | ServerMsgExit;

interface HeadlessEntry {
  sessionName: string;
  ccProcess: pty.IPty;
  terminal: HeadlessTerminalInstance;
  serializeAddon: SerializeAddonInstance;
  tmuxPaneId: string | null;
  lineBuffer: Buffer;
  pendingBytes: Buffer;
  inputQueue: string[];
  clients: Set<WebSocket>;
}

const headlessEntries = new Map<string, HeadlessEntry>();

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(entry: HeadlessEntry, msg: ServerMsg): void {
  for (const ws of entry.clients) send(ws, msg);
}

// 末尾に不完全な UTF-8 シーケンスがあれば次回繰越にする
function splitCompleteUtf8(buf: Buffer): { complete: Buffer; remainder: Buffer } {
  let i = buf.length;
  while (i > 0 && i > buf.length - 4) {
    i--;
    const b = buf[i];
    if ((b & 0x80) === 0) return { complete: buf, remainder: Buffer.alloc(0) };
    if ((b & 0xc0) === 0xc0) {
      let expectedLen = 0;
      if ((b & 0xe0) === 0xc0) expectedLen = 2;
      else if ((b & 0xf0) === 0xe0) expectedLen = 3;
      else if ((b & 0xf8) === 0xf0) expectedLen = 4;
      const remaining = buf.length - i;
      if (remaining < expectedLen) {
        return { complete: buf.subarray(0, i), remainder: buf.subarray(i) };
      }
      return { complete: buf, remainder: Buffer.alloc(0) };
    }
  }
  return { complete: buf, remainder: Buffer.alloc(0) };
}

// tmux Control Mode の 8進エスケープを生バイトに復号
function decodeOctalEscapesToBytes(data: string): Buffer {
  const bytes: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === '\\' && i + 1 < data.length) {
      const next = data[i + 1];
      if (next >= '0' && next <= '7' && i + 3 <= data.length) {
        const oct = data.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(oct)) {
          bytes.push(parseInt(oct, 8));
          i += 4;
          continue;
        }
      }
      switch (next) {
        case 'e': bytes.push(0x1b); i += 2; continue;
        case 'n': bytes.push(0x0a); i += 2; continue;
        case 'r': bytes.push(0x0d); i += 2; continue;
        case 't': bytes.push(0x09); i += 2; continue;
        case '\\': bytes.push(0x5c); i += 2; continue;
      }
    }
    bytes.push(data.charCodeAt(i) & 0xff);
    i++;
  }
  return Buffer.from(bytes);
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

/** 新規セッション直後はシェルプロンプト描画が非同期。capture-pane で2回連続同じ非空が取れたら ready */
function waitForShellReady(sessionName: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  let prev = '';
  while (Date.now() < deadline) {
    let cur = '';
    try {
      cur = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { /* ignore */ }
    if (cur.trim().length > 0 && cur === prev) return;
    prev = cur;
    sleepSync(30);
  }
}

async function createHeadlessEntry(
  sessionName: string,
  cols: number,
  rows: number,
): Promise<HeadlessEntry> {
  await ensureSession(sessionName);

  // クライアント独立サイズ運用: window-size manual + resize-window
  try {
    execFileSync('tmux', ['set-option', '-t', sessionName, 'window-size', 'manual'], { stdio: 'ignore' });
    execFileSync('tmux', ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' });
  } catch { /* ignore */ }

  // 新規セッション直後は描画安定を待つ
  waitForShellReady(sessionName, 500);

  // 初期 paneId とスクリーン状態を同期取得 → headless terminal に流し込んでおく
  let initialPaneId: string | null = null;
  let initialScreen = '';
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    initialPaneId = out.trim().split('\n')[0] || null;
  } catch { /* ignore */ }
  try {
    const captured = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', sessionName], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = captured.replace(/\n$/, '');
    initialScreen = trimmed.replace(/\n/g, '\r\n');
    const cursorOut = execFileSync('tmux', ['display-message', '-t', sessionName, '-p', '#{cursor_x},#{cursor_y}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [cx, cy] = cursorOut.trim().split(',').map((n) => parseInt(n, 10));
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      initialScreen += `\x1b[${cy + 1};${cx + 1}H`;
    }
  } catch { /* ignore */ }

  const terminal = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  const ccProc = pty.spawn('tmux', ['-CC', 'attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME ?? '/',
    env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
    encoding: null as unknown as 'utf-8', // バイナリで受信して自前 UTF-8 デコード
  });

  const entry: HeadlessEntry = {
    sessionName,
    ccProcess: ccProc,
    terminal,
    serializeAddon,
    tmuxPaneId: initialPaneId,
    lineBuffer: Buffer.alloc(0),
    pendingBytes: Buffer.alloc(0),
    inputQueue: [],
    clients: new Set(),
  };

  if (initialScreen) terminal.write(initialScreen);
  ccProc.write(`refresh-client -C ${cols},${rows}\n`);

  ccProc.onData((data: string | Buffer) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    entry.lineBuffer = Buffer.concat([entry.lineBuffer, chunk]);

    const byteChunks: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < entry.lineBuffer.length; i++) {
      if (entry.lineBuffer[i] === 0x0a) {
        let end = i;
        if (end > start && entry.lineBuffer[end - 1] === 0x0d) end--;
        const line = entry.lineBuffer.subarray(start, end).toString('latin1');
        start = i + 1;

        if (line.startsWith('%output ')) {
          const rest = line.slice(8);
          const spaceIdx = rest.indexOf(' ');
          const paneId = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
          const rawOutput = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);

          if (!entry.tmuxPaneId && paneId) {
            entry.tmuxPaneId = paneId;
            for (const cmd of entry.inputQueue) ccProc.write(cmd);
            entry.inputQueue = [];
          }

          if (rawOutput) byteChunks.push(decodeOctalEscapesToBytes(rawOutput));
        }
        // %begin / %end / %error 等は無視
      }
    }
    entry.lineBuffer = entry.lineBuffer.subarray(start);

    if (byteChunks.length > 0) {
      const allBytes = Buffer.concat([entry.pendingBytes, ...byteChunks]);
      const { complete, remainder } = splitCompleteUtf8(allBytes);
      entry.pendingBytes = remainder;
      if (complete.length > 0) {
        const decoded = complete.toString('utf-8');
        broadcast(entry, { type: 'output', data: decoded });
        terminal.write(decoded);
      }
    }
  });

  ccProc.onExit(({ exitCode }) => {
    headlessEntries.delete(sessionName);
    broadcast(entry, { type: 'exit', code: exitCode });
    try { terminal.dispose(); } catch { /* ignore */ }
  });

  return entry;
}

function applyResize(entry: HeadlessEntry, cols: number, rows: number): void {
  entry.terminal.resize(cols, rows);
  entry.ccProcess.write(`refresh-client -C ${cols},${rows}\n`);
  try {
    execFileSync('tmux', ['resize-window', '-t', entry.sessionName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

function handleClientMessage(entry: HeadlessEntry, ws: WebSocket, msg: ClientMsg): void {
  switch (msg.type) {
    case 'input': {
      if (typeof msg.data !== 'string' || !entry.tmuxPaneId) {
        if (typeof msg.data === 'string') {
          // pane id 未確定中はキューに溜める
          const hexArgs = Array.from(Buffer.from(msg.data)).map((b) => b.toString(16).padStart(2, '0'));
          entry.inputQueue.push(`send-keys -t pending -H ${hexArgs.join(' ')}\n`);
        }
        return;
      }
      const hexArgs = Array.from(Buffer.from(msg.data)).map((b) => b.toString(16).padStart(2, '0'));
      entry.ccProcess.write(`send-keys -t ${entry.tmuxPaneId} -H ${hexArgs.join(' ')}\n`);
      break;
    }
    case 'resize': {
      if (!Number.isFinite(msg.cols) || !Number.isFinite(msg.rows)) return;
      applyResize(entry, Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
      break;
    }
    case 'refresh': {
      const serialized = entry.serializeAddon.serialize();
      send(ws, { type: 'screen', serialized });
      break;
    }
  }
}

export function handlePtyConnection(ws: WebSocket, sessionName: string): void {
  try {
    validateName(sessionName);
  } catch (e) {
    ws.close(1008, (e as Error).message);
    return;
  }

  let entry: HeadlessEntry | null = null;
  let attached = false;

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()) as ClientMsg; }
    catch { return; }

    if (!attached) {
      if (msg.type !== 'attach') return;
      const cols = Math.max(1, (msg.cols ?? 80) | 0);
      const rows = Math.max(1, (msg.rows ?? 24) | 0);
      try {
        entry = headlessEntries.get(sessionName) ?? null;
        if (!entry) {
          entry = await createHeadlessEntry(sessionName, cols, rows);
          headlessEntries.set(sessionName, entry);
        } else {
          // 既存: 新クライアントの希望サイズに合わせる
          applyResize(entry, cols, rows);
        }
      } catch (err) {
        ws.close(1011, `attach failed: ${(err as Error).message}`);
        return;
      }
      entry.clients.add(ws);
      attached = true;

      // 現在の画面を一発で復元
      const serialized = entry.serializeAddon.serialize();
      if (serialized) send(ws, { type: 'screen', serialized });
      send(ws, { type: 'attached', cols, rows });
      return;
    }

    if (entry) handleClientMessage(entry, ws, msg);
  });

  const cleanup = (): void => {
    if (entry) {
      entry.clients.delete(ws);
      // 最後のクライアントが抜けても entry は残す (再接続で復元できるように)
      // ccProcess の終了でしか entry を消さない
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/** サーバ停止時のクリーンアップ。tmux セッション本体は残す */
export function cleanupAllHeadlessEntries(): void {
  for (const [, entry] of headlessEntries) {
    try { entry.ccProcess.kill(); } catch { /* ignore */ }
    try { entry.terminal.dispose(); } catch { /* ignore */ }
  }
  headlessEntries.clear();
}
