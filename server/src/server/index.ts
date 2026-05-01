import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, killSession, listSessions, sendKeys } from './tmux.ts';
import { handlePtyConnection } from './pty.ts';
import { getBackendName, isAsrReady, transcribePcm16, transcribeWav } from './asr/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(__dirname, '../../dist/web');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/sessions', async (c) => {
  return c.json({ sessions: await listSessions() });
});

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  try {
    await createSession(body.name);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.delete('/api/sessions/:name', async (c) => {
  try {
    await killSession(c.req.param('name'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
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
