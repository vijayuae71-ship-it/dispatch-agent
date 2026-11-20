// Runs the real server in demo mode (memory store) against a fake Claude, and
// plays a dispatch morning: confirmations, driver check-ins, an unanswered
// driver getting a call, a breakdown alert, and the Twilio WhatsApp webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import type { Server } from 'http';
import { startFakeClaude, seen } from './fake-claude';

const PORT = 19080 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-key';
let server: ChildProcess;
let claude: Server;

before(async () => {
  claude = await startFakeClaude(PORT + 1000);
  server = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      MODE: 'demo',
      STORE: 'memory',
      SKIP_SIGNATURE: 'true',
      PUBLIC_URL: BASE,
      ADMIN_KEY: KEY,
      ANTHROPIC_API_KEY: 'test',
      ANTHROPIC_BASE_URL: `http://localhost:${PORT + 1000}`,
      NO_BACKGROUND: 'true',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  server?.kill();
  claude?.close();
});

const api = async (path: string, body?: object) => {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-admin-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as any };
};
const delivery = (s: any, id: string) => s.deliveries.find((d: any) => d.id === id);
const thread = (s: any, phone: string) => s.threads.find((t: any) => t.phone === phone);

test('admin API needs the key; console is served', async () => {
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  const html = await (await fetch(BASE + '/')).text();
  assert.match(html, /Dispatch Agent/);
});

test('a demo dispatch morning', async () => {
  // 9:00 AM: five deliveries; the 11:00 client gets a confirmation request.
  let s = (await api('/api/demo/start', {})).json;
  assert.equal(s.deliveries.length, 5);
  assert.equal(s.clock.time, '9:00 AM');
  const askPatil = thread(s, '+919000000101');
  assert.match(askPatil.messages[0].text, /Namaste Patil Constructions.*ORD-1041.*11:00 AM.*MH-12-PQ-4821/);

  // Client confirms and gives the gate contact.
  await api('/api/demo/message', { phone: '+919000000101', text: 'Haan site ready hai, gate pe Sunil milega 9876543210' });
  s = (await api('/api/state')).json;
  const d1041 = delivery(s, 'ORD-1041');
  assert.equal(d1041.status, 'confirmed');
  assert.equal(d1041.site.contact, 'Sunil 9876543210');
  assert.match(thread(s, '+919000000101').messages.at(-1).text, /Dhanyavaad/);

  // 9:30: Gurpreet's 9:45 ETA is due → he's asked; he replies with traffic.
  s = (await api('/api/demo/advance', { minutes: 30 })).json;
  assert.equal(s.clock.time, '9:30 AM');
  assert.match(thread(s, '+919000000205').messages.at(-1).text, /ORD-1045/);
  await api('/api/demo/message', { phone: '+919000000205', text: 'traffic hai, 45 min lagega' });
  s = (await api('/api/state')).json;
  const d1045 = delivery(s, 'ORD-1045');
  assert.equal(d1045.status, 'delayed');
  assert.equal(d1045.lastLocation, 'Chandni Chowk flyover');

  // Suresh (ORD-1042, 10:30) is asked at 10:15 and never answers → call by 10:35.
  s = (await api('/api/demo/advance', { minutes: 70 })).json;
  assert.equal(s.clock.time, '10:40 AM');
  const call = s.calls.find((c: any) => c.phone === '+919000000202');
  assert.ok(call, 'driver should be called');
  assert.equal(call.status, 'ringing');

  // Answer the call: the bot opens in Hindi, the driver gives a location, the bot ends.
  let c = (await api('/api/demo/call', { callId: call.id, speech: null })).json.call;
  assert.equal(c.language, 'hi-IN');
  assert.match(c.transcript[0].text, /सुरेश जी/);
  c = (await api('/api/demo/call', { callId: call.id, speech: 'Aundh ke paas hoon, 20 minute' })).json.call;
  assert.equal(c.status, 'completed');
  s = (await api('/api/state')).json;
  assert.equal(delivery(s, 'ORD-1042').lastLocation, 'Aundh');
  assert.ok(!JSON.stringify(thread(s, '+919000000202').messages).includes('<<<'), 'metadata never shown');

  // A breakdown: critical alert, delivery flagged.
  await api('/api/demo/message', { phone: '+919000000205', text: 'truck ka tyre puncture ho gaya' });
  s = (await api('/api/state')).json;
  assert.equal(delivery(s, 'ORD-1045').status, 'issue');
  const alert = s.alerts.find((a: any) => a.severity === 'critical');
  assert.match(alert.text, /puncture/);
  assert.equal((await api('/api/alerts/resolve', { id: alert.id })).status, 200);
});

test('WhatsApp webhook: a client asks where the truck is', async () => {
  const r = await fetch(`${BASE}/twilio/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: 'whatsapp:+919000000101', Body: 'Truck kab aayega?', NumMedia: '0' }),
  });
  assert.match(await r.text(), /<Response><\/Response>/);
  let reply: any;
  for (let i = 0; i < 30 && !reply; i++) {
    await new Promise((x) => setTimeout(x, 100));
    const s = (await api('/api/state')).json;
    const t = thread(s, '+919000000101');
    if (t.messages.at(-1).direction === 'out' && /11:00/.test(t.messages.at(-1).text)) reply = t.messages.at(-1);
  }
  assert.ok(reply, 'bot replied');
  // The AI was given the client's delivery data, not the driver's phone.
  const req = seen.filter((b) => !b.stream).at(-1);
  assert.match(JSON.stringify(req), /ORD-1041/);
});

test('API: add deliveries with validation', async () => {
  const bad = (await api('/api/deliveries', { deliveries: [{ id: 'X1', client: { phone: '123' } }] })).json;
  assert.equal(bad.results[0].ok, false);
  const ok = (
    await api('/api/deliveries', {
      deliveries: [
        {
          id: 'API-1', material: 'Aggregates', truck: 'KA-01-AB-1111', plannedAt: new Date(Date.now() + 86400000).toISOString(),
          client: { name: 'A', phone: '+919000000301' }, driver: { name: 'B', phone: '+919000000302' }, site: { name: 'Whitefield' },
        },
      ],
    })
  ).json;
  assert.equal(ok.results[0].ok, true);
});

test('live call over the ConversationRelay WebSocket', async () => {
  const { WebSocket } = await import('ws');
  await api('/api/demo/start', {});
  const s = (await api('/api/demo/advance', { minutes: 100 })).json;
  const call = s.calls.find((c: any) => c.phone === '+919000000202' && c.status === 'ringing');
  assert.ok(call, 'driver call placed');

  // Twilio fetches TwiML when the call is answered.
  const twimlRes = await fetch(`${BASE}/twilio/voice?call=${call.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: 'CA1' }),
  });
  const xml = await twimlRes.text();
  assert.match(xml, /<ConversationRelay url="ws:\/\/localhost:\d+\/relay" language="mr-IN"/); // Suresh is a Marathi speaker
  assert.match(xml, /<Parameter name="call" value="[^"]+"\/>/);
  assert.equal((xml.match(/<Language /g) || []).length, 10);

  const ws = new WebSocket(`ws://localhost:${PORT}/relay`);
  const got: any[] = [];
  let waiters: ((m: any) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    got.push(m);
    waiters.forEach((w) => w(m));
  });
  const until = (f: (m: any) => boolean) =>
    new Promise<any>((ok) => {
      const w = (m: any) => f(m) && (waiters = waiters.filter((x) => x !== w), ok(m));
      waiters.push(w);
    });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'setup', callSid: 'CA1', customParameters: { call: call.id } }));
  await until((m) => m.type === 'text' && m.last);
  const opening = got.filter((m) => m.type === 'text').map((m) => m.token).join('');
  assert.match(opening, /सुरेश जी/);
  assert.ok(!opening.includes('[[') && !opening.includes('<<<'));

  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Aundh ke paas hoon, bees minute', last: true }));
  const end = await until((m) => m.type === 'end');
  assert.match(end.handoffData, /"action":"end"/);
  ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const after = (await api('/api/state')).json;
  assert.equal(after.deliveries.find((d: any) => d.id === 'ORD-1042').lastLocation, 'Aundh');
  assert.equal(after.calls.find((c: any) => c.id === call.id).status, 'completed');
});

test("client gets the driver's number; an unknown caller doesn't", async () => {
  await api('/api/demo/start', {});
  await api('/api/demo/message', { phone: '+919000000101', text: 'driver ka number do' });
  let s = (await api('/api/state')).json;
  assert.match(thread(s, '+919000000101').messages.at(-1).text, /\+919000000201/); // Ramesh, ORD-1041's driver
  assert.equal(s.alerts.length, 0, 'no alert needed when the bot can answer');

  await api('/api/demo/message', { phone: '+919999999999', text: 'driver ka number do' });
  const unknownReq = seen.filter((b) => !b.stream).at(-1);
  assert.doesNotMatch(JSON.stringify(unknownReq), /\(phone \+91/);
});

test('a repeated request raises one alert, not two', async () => {
  await api('/api/demo/start', {});
  await api('/api/demo/message', { phone: '+919000000101', text: 'please call back' });
  await api('/api/demo/message', { phone: '+919000000101', text: 'call back jaldi please' });
  const s = (await api('/api/state')).json;
  assert.equal(s.alerts.filter((a: any) => a.deliveryId === 'ORD-1041').length, 1);
  // A more serious problem on the same delivery still gets through.
  await api('/api/demo/message', { phone: '+919000000201', text: 'truck ka tyre puncture ho gaya' });
  const after = (await api('/api/state')).json.alerts.filter((a: any) => a.deliveryId === 'ORD-1041');
  assert.equal(after.length, 2);
  assert.ok(after.some((a: any) => a.severity === 'critical'));
});

test('alerts go to every clerk; take and done work on WhatsApp and the console', async () => {
  await api('/api/demo/start', {});
  // A breakdown raises a critical alert → all three demo clerks get it with a number.
  await api('/api/demo/message', { phone: '+919000000205', text: 'truck ka tyre puncture ho gaya' });
  let s = (await api('/api/state')).json;
  assert.equal(s.clerks.length, 3);
  const a = s.alerts.find((x: any) => x.severity === 'critical');
  for (const c of s.clerks) assert.match(thread(s, c.phone).messages.at(-1).text, new RegExp(`#${a.number}:.*take ${a.number}`));

  // Anita takes it on WhatsApp; Farhan and Joseph are told; Farhan can't take it too.
  await api('/api/demo/message', { phone: '+919000000901', text: `take ${a.number}` });
  s = (await api('/api/state')).json;
  assert.equal(s.alerts.find((x: any) => x.id === a.id).assignedTo, 'Anita');
  assert.match(thread(s, '+919000000901').messages.at(-1).text, /is yours/);
  assert.match(thread(s, '+919000000902').messages.at(-1).text, /Anita took #/);
  await api('/api/demo/message', { phone: '+919000000902', text: `take ${a.number}` });
  s = (await api('/api/state')).json;
  assert.match(thread(s, '+919000000902').messages.at(-1).text, /already with Anita/);

  // "list" shows it; Anita closes it.
  await api('/api/demo/message', { phone: '+919000000903', text: 'list' });
  s = (await api('/api/state')).json;
  assert.match(thread(s, '+919000000903').messages.at(-1).text, new RegExp(`#${a.number}.*Anita`));
  await api('/api/demo/message', { phone: '+919000000901', text: `done ${a.number}` });
  s = (await api('/api/state')).json;
  const closed = s.alerts.find((x: any) => x.id === a.id);
  assert.equal(closed.resolved, true);
  assert.equal(closed.resolvedBy, 'Anita');

  // Console: Take/Close by a named clerk.
  await api('/api/demo/message', { phone: '+919000000101', text: 'please call back' });
  s = (await api('/api/state')).json;
  const b = s.alerts.find((x: any) => !x.resolved);
  assert.equal((await api('/api/alerts/assign', { id: b.id, clerk: 'Joseph' })).status, 200);
  assert.equal((await api('/api/alerts/assign', { id: b.id, clerk: 'Farhan' })).status, 409);
  assert.equal((await api('/api/alerts/resolve', { id: b.id, clerk: 'Joseph' })).status, 200);
});

test('site engineers are recognised, and every client contact hears about delays', async () => {
  await api('/api/demo/start', {});
  // Sunil, Patil Constructions' site engineer, asks about the truck: treated as the client.
  await api('/api/demo/message', { phone: '+919000000111', text: 'truck kab aayega?' });
  const req = seen.filter((b) => !b.stream).at(-1);
  assert.match(JSON.stringify(req), /Sunil \(Site engineer\), Patil Constructions \(client\)/);
  assert.match(JSON.stringify(req), /ORD-1041/);

  // Gurpreet runs late → Deshmukh & Sons and their site supervisor both get a WhatsApp update, once.
  await api('/api/demo/advance', { minutes: 30 });
  await api('/api/demo/message', { phone: '+919000000205', text: 'traffic hai, 45 min lagega' });
  await api('/api/demo/message', { phone: '+919000000205', text: 'traffic hai, 45 min lagega' });
  const s = (await api('/api/state')).json;
  for (const phone of ['+919000000105', '+919000000115']) {
    const updates = thread(s, phone).messages.filter((m: any) => /ORD-1045.*(late|update)/i.test(m.text));
    assert.equal(updates.length, 1, `one delay update for ${phone}`);
  }
});
