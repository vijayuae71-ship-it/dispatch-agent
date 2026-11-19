import { timingSafeEqual } from 'crypto';
import { config } from './lib/config';
import { advanceClock, fmtTime, fmtDateTime, now } from './lib/clock';
import { demoCallTurn, endCall, handleInbound, tick } from './lib/engine';
import { isDemo } from './lib/outbox';
import { startDemoDay } from './lib/demo';
import { sheetConfigured, syncSheet } from './lib/sheets';
import {
  addAlert,
  getCall,
  getDelivery,
  listAlerts,
  listCalls,
  listDeliveries,
  listThreads,
  resolveAlert,
  saveDelivery,
  storeKind,
} from './lib/store';
import { conversationRelayTwiml, isE164, stripWhatsApp, twiml } from './lib/twilio';
import type { Delivery } from './lib/types';

export interface Req {
  method: string;
  path: string;
  pathAndQuery: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  form: Record<string, string>;
  json: any;
}
export interface Res {
  status: number;
  type?: string;
  body: string;
}

const xml = (body: string): Res => ({ status: 200, type: 'text/xml; charset=utf-8', body });
const json = (status: number, data: unknown): Res => ({ status, type: 'application/json', body: JSON.stringify(data) });
const empty = (): Res => ({ status: 204, body: '' });

export function adminDenied(req: Req): Res | null {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return json(503, { error: 'ADMIN_KEY is not configured on the server.' });
  const got = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { error: 'Invalid admin key.' });
  return null;
}

// Inbound WhatsApp messages from the same number are handled in order.
const perPhone = new Map<string, Promise<unknown>>();
function queueFor(phone: string, fn: () => Promise<unknown>) {
  const prev = perPhone.get(phone) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => console.error('inbound:', e));
  perPhone.set(phone, next);
  next.finally(() => perPhone.get(phone) === next && perPhone.delete(phone));
  return next;
}

// ------------------------------------------------------------ Twilio webhooks

/** Incoming WhatsApp message. Acknowledge at once; reply via the API when ready. */
export async function whatsappInbound(req: Req): Promise<Res> {
  const phone = stripWhatsApp(req.form.From || '');
  if (!phone) return xml(twiml(''));
  const hasMedia = Number(req.form.NumMedia || 0) > 0;
  void queueFor(phone, () => handleInbound(phone, req.form.Body || '', { hasMedia }));
  return xml(twiml(''));
}

/** Delivery receipts: flag messages WhatsApp couldn't deliver. */
export async function messageStatus(req: Req): Promise<Res> {
  const st = req.form.MessageStatus;
  if (st === 'failed' || st === 'undelivered') {
    await addAlert({ severity: 'warning', text: `WhatsApp message to ${stripWhatsApp(req.form.To || '')} ${st} (Twilio error ${req.form.ErrorCode || '?'}).` });
  }
  return empty();
}

/** Escalation call answered → stream it through ConversationRelay. */
export async function voice(req: Req): Promise<Res> {
  const id = req.query.get('call') || '';
  const call = await getCall(id);
  if (!call) return xml(twiml('<Hangup/>'));
  if (req.form.AnsweredBy?.startsWith('machine')) {
    await endCall(id, 'failed');
    return xml(twiml('<Hangup/>'));
  }
  return xml(conversationRelayTwiml(call.id, call.language));
}

export async function handoff(): Promise<Res> {
  return xml(twiml('<Hangup/>'));
}

export async function callStatus(req: Req): Promise<Res> {
  const id = req.query.get('call') || '';
  const st = req.form.CallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(st)) await endCall(id, 'failed');
  else if (st === 'completed') await endCall(id, 'completed');
  return empty();
}

// ----------------------------------------------------------------- admin API

export async function state(): Promise<Res> {
  const [deliveries, alerts, threads, calls] = await Promise.all([listDeliveries(), listAlerts(), listThreads(), listCalls()]);
  return json(200, {
    mode: isDemo() ? 'demo' : 'live',
    store: storeKind(),
    company: config().company,
    agentName: config().agentName,
    languages: config().languages.map((l) => ({ code: l.code, name: l.name })),
    sheet: sheetConfigured(),
    clock: { now: now().toISOString(), time: fmtTime(now().toISOString()), label: fmtDateTime(now().toISOString()) },
    deliveries: deliveries.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt)),
    alerts,
    threads,
    calls: calls.filter((c) => c.status === 'ringing' || c.status === 'in_progress' || now().getTime() - Date.parse(c.startedAt) < 6 * 3600_000),
  });
}

/** Add or update deliveries from another system: { deliveries: [...] } */
export async function upsertDeliveries(req: Req): Promise<Res> {
  const list: Partial<Delivery>[] = Array.isArray(req.json?.deliveries) ? req.json.deliveries : [];
  if (!list.length) return json(400, { error: 'deliveries[] is required' });
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const x of list) {
    const id = String(x.id || x.orderNo || '');
    const problems = [
      !id && 'id or orderNo',
      !x.client?.phone || !isE164(x.client.phone) ? 'client.phone (E.164)' : '',
      !x.driver?.phone || !isE164(x.driver.phone) ? 'driver.phone (E.164)' : '',
      !x.plannedAt || isNaN(Date.parse(x.plannedAt)) ? 'plannedAt (ISO 8601)' : '',
      !x.site?.name && 'site.name',
      !x.truck && 'truck',
    ].filter(Boolean);
    if (problems.length) {
      results.push({ id, ok: false, error: `Missing or invalid: ${problems.join(', ')}` });
      continue;
    }
    const existing = await getDelivery(id);
    const d: Delivery = {
      ...(existing || { status: 'scheduled', flags: {}, source: 'api' as const, updatedAt: '' }),
      ...x,
      id,
      orderNo: String(x.orderNo || id),
      material: String(x.material || existing?.material || 'Material'),
      plannedAt: new Date(x.plannedAt!).toISOString(),
      flags: existing?.flags || {},
    } as Delivery;
    await saveDelivery(d);
    results.push({ id, ok: true });
  }
  return json(200, { results });
}

export async function resolve(req: Req): Promise<Res> {
  if (!req.json?.id) return json(400, { error: 'id is required' });
  await resolveAlert(String(req.json.id));
  return json(200, { ok: true });
}

export async function runTick(): Promise<Res> {
  const actions = await tick();
  return json(200, { actions });
}

export async function sync(): Promise<Res> {
  try {
    return json(200, await syncSheet());
  } catch (err: any) {
    return json(500, { error: err?.message || 'Sheet sync failed' });
  }
}

// ------------------------------------------------------------------- demo

function demoOnly(): Res | null {
  return isDemo() ? null : json(403, { error: 'Demo controls are off in live mode (MODE=live).' });
}

export async function demoStart(): Promise<Res> {
  const denied = demoOnly();
  if (denied) return denied;
  if (storeKind() !== 'memory') return json(400, { error: 'Demo mode needs STORE=memory, so it never touches real data.' });
  await startDemoDay();
  await tick();
  return state();
}

export async function demoAdvance(req: Req): Promise<Res> {
  const denied = demoOnly();
  if (denied) return denied;
  const minutes = Math.max(1, Math.min(240, Number(req.json?.minutes) || 15));
  // Step through in 5-minute slices so rules fire in the order they would in real time.
  for (let left = minutes; left > 0; left -= 5) {
    advanceClock(Math.min(5, left));
    await tick();
  }
  return state();
}

/** Play a client or driver: send a WhatsApp message as them. */
export async function demoMessage(req: Req): Promise<Res> {
  const denied = demoOnly();
  if (denied) return denied;
  const phone = String(req.json?.phone || '');
  const text = String(req.json?.text || '').trim();
  if (!phone || !text) return json(400, { error: 'phone and text are required' });
  const r = await queueFor(phone, () => handleInbound(phone, text));
  return json(200, { result: r });
}

/** Answer / speak on / hang up a ringing call. */
export async function demoCall(req: Req): Promise<Res> {
  const denied = demoOnly();
  if (denied) return denied;
  const id = String(req.json?.callId || '');
  if (req.json?.hangup) {
    await endCall(id, req.json?.decline ? 'failed' : 'completed');
    return json(200, { ok: true });
  }
  try {
    const speech = req.json?.speech === undefined || req.json?.speech === null ? null : String(req.json.speech);
    const call = await demoCallTurn(id, speech);
    return json(200, { call });
  } catch (err: any) {
    return json(400, { error: err?.message || 'call failed' });
  }
}
