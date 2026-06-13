import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { PORT, UI_DIST } from '../config.js';
import { logger } from '../logger.js';
import type { App } from '../app.js';
import { registerRoutes } from './routes.js';

const HOST = process.env.HOST || '127.0.0.1';
const AUTH_USER = process.env.DASHBOARD_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASSWORD || '';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startWebServer(app: App): Promise<void> {
  const fastify = Fastify({ logger: false });

  // ---- access control: HTTP Basic Auth (only when a password is configured) ----
  // Protects every route incl. the dashboard, REST API and WebSocket. The browser
  // prompts once and remembers, so phone + laptop just work after one login.
  if (AUTH_PASS) {
    const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
    fastify.addHook('onRequest', async (req, reply) => {
      const provided = req.headers.authorization ?? '';
      if (!safeEqual(provided, expected)) {
        reply.header('WWW-Authenticate', 'Basic realm="ForceAI"').code(401).send('Authentication required');
      }
    });
  }

  // accept raw binary uploads (the one-time data import) as a Buffer
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 209_715_200 },
    (_req, body, done) => done(null, body),
  );

  await fastify.register(fastifyWebsocket);

  if (fs.existsSync(UI_DIST)) {
    await fastify.register(fastifyStatic, { root: UI_DIST, prefix: '/' });
  } else {
    fastify.get('/', async (_req, reply) => {
      reply.type('text/html').send(
        '<h1>ForceAI</h1><p>UI not built yet — run <code>npm run build:ui</code>. API is live at <code>/api/status</code>.</p>'
      );
    });
  }

  await registerRoutes(fastify, app);

  fastify.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = app.bus.subscribe((event) => {
      try { socket.send(JSON.stringify(event)); } catch { /* client gone */ }
    });
    // greet with current status so the UI can render immediately
    try { socket.send(JSON.stringify({ kind: 'status', status: app.statusPayload() })); } catch { /* ignore */ }
    socket.on('close', unsubscribe);
  });

  await fastify.listen({ port: PORT, host: HOST });

  const exposed = HOST !== '127.0.0.1' && HOST !== 'localhost';
  if (exposed && !AUTH_PASS) {
    logger.warn('============================================================');
    logger.warn('⚠  DASHBOARD IS EXPOSED ON THE NETWORK WITHOUT A PASSWORD!');
    logger.warn('⚠  Anyone who reaches this port can send messages as you.');
    logger.warn('⚠  Set DASHBOARD_PASSWORD in your environment, then restart.');
    logger.warn('============================================================');
  }
  logger.info(`dashboard: http://${HOST === '0.0.0.0' ? '<server-ip>' : HOST}:${PORT}${AUTH_PASS ? ' (password protected)' : ''}`);
}
