/**
 * Dispatch Agent: one HTTP + WebSocket service.
 *
 *   GET  /                       console (dispatch board, alerts, chats, demo controls)
 *   GET  /healthz
 *   POST /twilio/whatsapp        incoming WhatsApp message
 *   POST /twilio/message-status  WhatsApp delivery receipts
 *   POST /twilio/voice           escalation call answered → TwiML
 *   POST /twilio/handoff         call session ended
 *   POST /twilio/call-status     call status callback
 *   WS   /relay                  ConversationRelay live-call stream
 *   /api/*                       admin API (header x-admin-key: $ADMIN_KEY)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WebSocketServer } from 'ws';
import * as routes from './routes';
import { attachRelay, relaySignatureOk } from './relay';
import { twilioRequestOk } from './lib/twilio';
import { tick } from './lib/engine';
import { isDemo } from './lib/outbox';
import { sheetConfigured, syncSheet } from './lib/sheets';
import { loadConfig } from './lib/config';
import { storeKind } from './lib/store';

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 1_000_000;
const CONSOLE_HTML = readFileSync(resolve(process.env.PUBLIC_DIR || 'public', 'console.html'), 'utf8');
loadConfig();

type Handler = (req: routes.Req) => Promise<routes.Res>;
const twilioRoutes: Record<string, Handler> = {
  '/twilio/whatsapp': routes.whatsappInbound,
  '/twilio/message-status': routes.messageStatus,
  '/twilio/voice': routes.voice,
  '/twilio/handoff': routes.handoff,
  '/twilio/call-status': routes.callStatus,
};
const adminRoutes: Record<string, { method: string; fn: Handler }> = {
  '/api/state': { method: 'GET', fn: routes.state },
  '/api/deliveries': { method: 'POST', fn: routes.upsertDeliveries },
  '/api/alerts/resolve': { method: 'POST', fn: routes.resolve },
  '/api/tick': { method: 'POST', fn: routes.runTick },
  '/api/sync': { method: 'POST', fn: routes.sync },
  '/api/demo/start': { method: 'POST', fn: routes.demoStart },
  '/api/demo/advance': { method: 'POST', fn: routes.demoAdvance },
  '/api/demo/message': { method: 'POST', fn: routes.demoMessage },
  '/api/demo/call': { method: 'POST', fn: routes.demoCall },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function send(res: ServerResponse, r: routes.Res) {
  res.writeHead(r.status, { ...(r.type ? { 'Content-Type': r.type } : {}), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(r.body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://local');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (method === 'GET' && (path === '/' || path === '/console')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    });
    return res.end(CONSOLE_HTML);
  }
  if (path === '/healthz') return send(res, { status: 200, type: 'text/plain', body: 'ok' });

  const base: routes.Req = { method, path, pathAndQuery: req.url || '/', query: url.searchParams, headers: req.headers, form: {}, json: null };

  const tw = twilioRoutes[path];
  if (tw && method === 'POST') {
    base.form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const sig = req.headers['x-twilio-signature'];
    if (!twilioRequestOk(base.pathAndQuery, base.form, typeof sig === 'string' ? sig : null)) {
      return send(res, { status: 403, type: 'text/plain', body: 'Invalid signature' });
    }
    return send(res, await tw(base));
  }

  const admin = adminRoutes[path];
  if (admin) {
    if (method !== admin.method) return send(res, { status: 405, body: '' });
    const denied = routes.adminDenied(base);
    if (denied) return send(res, denied);
    if (method === 'POST') {
      const raw = await readBody(req);
      try {
        base.json = raw ? JSON.parse(raw) : {};
      } catch {
        return send(res, { status: 400, type: 'application/json', body: '{"error":"Invalid JSON"}' });
      }
    }
    return send(res, await admin.fn(base));
  }
  send(res, { status: 404, type: 'text/plain', body: 'Not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('http:', err);
    if (!res.headersSent) send(res, { status: 500, type: 'text/plain', body: 'Server error' });
    else res.end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url || '/', 'http://local').pathname;
  if (path !== '/relay' || !relaySignatureOk(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachRelay(ws));
});

// Background loops: dispatch rules every minute, sheet sync every couple of minutes.
const TICK_MS = Number(process.env.TICK_SECONDS || 60) * 1000;
const SYNC_MS = Number(process.env.SHEET_SYNC_SECONDS || 120) * 1000;
if (process.env.NO_BACKGROUND !== 'true') {
  setInterval(() => tick().catch((e) => console.error('tick:', e)), TICK_MS).unref();
  if (sheetConfigured()) {
    const run = () => syncSheet().then((r) => r.errors.length && console.warn('sheet:', r.errors.join('; '))).catch((e) => console.error('sheet sync:', e.message));
    run();
    setInterval(run, SYNC_MS).unref();
  }
}

if (isDemo() && storeKind() !== 'memory') {
  console.warn('Demo mode with Firestore: demo controls are disabled. Set STORE=memory for demos, or MODE=live for production.');
}

server.listen(PORT, () => console.log(`dispatch-agent (${isDemo() ? 'demo' : 'live'}, ${storeKind()} store) listening on :${PORT}`));
