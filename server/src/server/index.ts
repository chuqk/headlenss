import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureOutput, createSession, killSession, listSessions, sendKeys } from './tmux.ts';
import { handlePtyConnection } from './pty.ts';
import { getBackendName, isAsrReady, transcribePcm16, transcribeWav } from './asr/index.ts';
import { claudeRouter } from './claude/router.ts';
import { detectClaudeSessions } from './claude/process-detect.ts';
import * as claudeStore from './claude/store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(__dirname, '../../dist/web');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/sessions', async (c) => {
  const [sessions, detected] = await Promise.all([
    listSessions(),
    detectClaudeSessions().catch(() => []),
  ]);
  const detectedMap = new Map(detected.map((d) => [d.tmuxSessionName, d]));
  const enriched = sessions.map((s) => ({
    ...s,
    claudeStatus: detectedMap.get(s.name)?.status,
  }));
  return c.json({ sessions: enriched });
});

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ name?: string; cwd?: string; startClaude?: boolean }>();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  try {
    await createSession(body.name, {
      cwd: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
      startClaude: body.startClaude === true,
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.delete('/api/sessions/:name', async (c) => {
  const name = c.req.param('name');
  try {
    await killSession(name);
    // hook 経由で記録された Claude セッションエントリも合わせて削除する。
    // これをやらないと /api/claude/sessions に死んだ tmux セッションが残り続ける。
    claudeStore.removeSession(name);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/sessions/:name/output', async (c) => {
  const name = c.req.param('name');
  const lines = Number(c.req.query('lines') ?? 24);
  try {
    const text = await captureOutput(name, Number.isFinite(lines) ? lines : 24);
    return c.json({ text });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.includes("can't find session") || msg.includes('no server running') ? 404 : 400;
    return c.json({ error: msg }, status);
  }
});

app.post('/api/sessions/:name/input', async (c) => {
  const name = c.req.param('name');
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; submit?: unknown };
  if (typeof body.text !== 'string') {
    return c.json({ error: 'body must be { "text": string, "submit"?: boolean }' }, 400);
  }
  try {
    await sendKeys(name, body.text, body.submit === true);
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.includes("can't find session") || msg.includes('no server running') ? 404 : 400;
    return c.json({ error: msg }, status);
  }
});

app.route('/api', claudeRouter);

// ───────── 画像アップロード (Web UI → Claude Code) ─────────
//
// 来たバイナリを tmp に保存して path を返すだけ。形式チェックや圧縮は Claude Code 側に任せる。
// (拡張子は Content-Type / X-Filename ヘッダから決める。不明なら .bin)
const UPLOAD_DIR = resolve(tmpdir(), 'headlenss-uploads');
const UPLOAD_TTL_MS = 60 * 60 * 1000;

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

async function ensureUploadDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

async function cleanupOldUploads(): Promise<void> {
  try {
    const files = await readdir(UPLOAD_DIR);
    const now = Date.now();
    for (const f of files) {
      try {
        const p = resolve(UPLOAD_DIR, f);
        const s = await stat(p);
        if (now - s.mtimeMs > UPLOAD_TTL_MS) await unlink(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

ensureUploadDir().catch(() => { /* ignore */ });
setInterval(() => { void cleanupOldUploads(); }, 30 * 60 * 1000);

app.post('/api/uploads', async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) return c.json({ error: 'empty body' }, 400);
  const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // 拡張子の決定優先順: Content-Type → X-Filename ヘッダ → 'bin'
  let ext = MIME_TO_EXT[ct] ?? '';
  if (!ext) {
    const fn = c.req.header('x-filename') ?? '';
    const m = fn.match(/\.([a-zA-Z0-9]{1,8})$/);
    if (m) ext = m[1].toLowerCase();
  }
  if (!ext) ext = 'bin';
  await ensureUploadDir();
  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  const path = resolve(UPLOAD_DIR, filename);
  await writeFile(path, buf);
  return c.json({ path, bytes: buf.length });
});

// アップロード済画像の配信 (chat UI で `@/tmp/headlenss-uploads/...` を
// インライン画像表示するために必要)。
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

app.get('/api/uploads/:filename', (c) => {
  const filename = c.req.param('filename');
  // path traversal 防止: filename は単一パス要素のみ許可
  if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.startsWith('.') || filename.includes('..')) {
    return c.json({ error: 'invalid filename' }, 400);
  }
  const path = resolve(UPLOAD_DIR, filename);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  const buf = readFileSync(path);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  c.header('Content-Type', EXT_TO_MIME[ext] ?? 'application/octet-stream');
  c.header('Cache-Control', 'private, max-age=3600');
  return c.body(new Uint8Array(buf));
});

// .ehpk ダウンロード (G2 アプリ install 用)
const EVEN_DIR = resolve(__dirname, '../../../even');

/** even/ 配下から最新の headlenss[-x.y.z].ehpk を見つける (バージョンの semver 降順、なければ mtime 降順) */
function findLatestEhpk(): { name: string; path: string } | null {
  const candidates: Array<{ name: string; path: string; version: string | null; mtime: number }> = [];
  try {
    for (const f of readdirSync(EVEN_DIR)) {
      if (!/^headlenss(-[\d.]+)?\.ehpk$/i.test(f)) continue;
      const path = resolve(EVEN_DIR, f);
      const m = f.match(/^headlenss-([\d.]+)\.ehpk$/i);
      const version = m ? m[1] : null;
      candidates.push({ name: f, path, version, mtime: statSync(path).mtimeMs });
    }
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.version && b.version) return cmpSemver(b.version, a.version);
    if (a.version) return -1;
    if (b.version) return 1;
    return b.mtime - a.mtime;
  });
  const top = candidates[0];
  return { name: top.name, path: top.path };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

app.get('/download/ehpk', (c) => {
  const latest = findLatestEhpk();
  if (!latest) {
    return c.json({ error: 'no .ehpk found in even/. run: cd even && npm run pack' }, 404);
  }
  const buf = readFileSync(latest.path);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${latest.name}"`);
  c.header('Content-Length', String(buf.byteLength));
  return c.body(new Uint8Array(buf));
});

app.get('/api/asr/status', (c) => c.json({ backend: getBackendName(), ...isAsrReady() }));

app.post('/api/asr', async (c) => {
  const ready = isAsrReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);

  const ct = (c.req.header('content-type') ?? 'application/octet-stream').toLowerCase();
  const lang = c.req.query('lang') || undefined;
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) return c.json({ error: 'empty body' }, 400);

  try {
    let result;
    if (ct.startsWith('audio/wav') || ct.startsWith('audio/x-wav') || ct.startsWith('audio/wave')) {
      result = await transcribeWav(buf, lang);
    } else if (ct.startsWith('audio/l16') || ct.startsWith('audio/pcm') || ct === 'application/octet-stream') {
      result = await transcribePcm16(buf, lang);
    } else {
      return c.json({ error: `unsupported content-type: ${ct}. use audio/wav or audio/l16` }, 415);
    }
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

if (existsSync(WEB_DIST)) {
  const indexHtml = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('/*', (c) => c.html(indexHtml));
} else {
  app.get('/', (c) =>
    c.text(
      'headlenss server is running, but the web UI has not been built yet.\n' +
        'Run `npm run build` to build the UI, or `npm run dev` for development mode.\n',
    ),
  );
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const host = info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address;
  console.log(`headlenss server listening:`);
  console.log(`  local:    http://${host}:${info.port}`);
  console.log(`  bound to: ${info.address}:${info.port}`);
  if (!existsSync(WEB_DIST)) {
    console.log(`\nweb UI not built. run \`npm run build\` (or use \`npm run dev\`).`);
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const m = (req.url ?? '').match(/^\/api\/sessions\/([^/?#]+)\/pty/);
  if (!m) {
    socket.destroy();
    return;
  }
  const name = decodeURIComponent(m[1]);
  wss.handleUpgrade(req, socket, head, (ws) => handlePtyConnection(ws, name));
});
