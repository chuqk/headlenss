import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, killSession, listSessions } from './tmux.ts';
import { handlePtyConnection } from './pty.ts';

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
