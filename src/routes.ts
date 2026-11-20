import { timingSafeEqual } from 'crypto';
import { applySettings, config, normalizePhone, type Settings } from './lib/config';
import { INDUSTRIES, REGIONS, industryOf } from './lib/industries';
import { templatesFor } from './lib/templates';
import { advanceClock, fmtTime, fmtDateTime, now } from './lib/clock';
import { demoCallTurn, endCall, handleInbound, tick } from './lib/engine';
import { assignAlert, closeAlert } from './lib/clerks';
import { assignTruck } from './lib/assign';
import { isDemo } from './lib/outbox';
import { SCENARIOS, startDemoDay, type Scenario } from './lib/demo';
import { sheetConfigured, syncSheet } from './lib/sheets';
import {
  addAlert,
  getCall,
  getDelivery,
  listAlerts,
  listCalls,
  listDeliveries,
  listThreads,
  saveSettings,
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
    clerks: config().dispatchers,
    setupAt: config().setupAt || null,
    industry: { id: config().industry, label: industryOf(config().industry).label },
    scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label })),
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
    const badContact = (x.contacts || []).some((c) => !c?.phone || !isE164(c.phone));
    const problems = [
      badContact && 'contacts[].phone (E.164)',
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

/** { id, clerk? }: close an alert from the console. */
export async function resolve(req: Req): Promise<Res> {
  if (!req.json?.id) return json(400, { error: 'id is required' });
  const clerk = String(req.json.clerk || '').trim();
  if (!clerk) {
    await resolveAlert(String(req.json.id));
    return json(200, { ok: true });
  }
  const r = await closeAlert(String(req.json.id), clerk);
  return json(r.ok ? 200 : 409, r);
}

/** { ref, truck, driverPhone, driverName?, clerk? }: put a truck and driver on an order. */
export async function assignDelivery(req: Req): Promise<Res> {
  const b = req.json || {};
  if (!b.ref || !b.truck || !b.driverPhone) return json(400, { error: 'ref, truck and driverPhone are required' });
  const r = await assignTruck({ ref: String(b.ref), truck: String(b.truck), driverPhone: String(b.driverPhone), driverName: b.driverName ? String(b.driverName) : undefined, by: String(b.clerk || 'Dispatcher') });
  return json(r.ok ? 200 : 409, r);
}

/** { id, clerk }: a clerk takes an alert from the console. */
export async function assign(req: Req): Promise<Res> {
  const id = String(req.json?.id || '');
  const clerk = String(req.json?.clerk || '').trim();
  if (!id || !clerk) return json(400, { error: 'id and clerk are required' });
  const r = await assignAlert(id, clerk);
  return json(r.ok ? 200 : 409, r);
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

export async function demoStart(req: Req): Promise<Res> {
  const denied = demoOnly();
  if (denied) return denied;
  if (storeKind() !== 'memory') return json(400, { error: 'Demo mode needs STORE=memory, so it never touches real data.' });
  const scenario = String(req.json?.scenario || 'construction');
  if (!(scenario in SCENARIOS)) return json(400, { error: `Unknown scenario. Options: ${Object.keys(SCENARIOS).join(', ')}` });
  await startDemoDay(scenario as Scenario);
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

// ------------------------------------------------------------------ setup

function currentSettings() {
  const c = config();
  return {
    company: c.company,
    agentName: c.agentName,
    industry: c.industry,
    region: c.region,
    businessDescription: c.businessDescription || '',
    dispatchers: c.dispatchers,
    setupAt: c.setupAt || null,
  };
}

/** What the setup wizard needs: current settings, the choices, and this industry's WhatsApp templates. */
export async function getSetup(): Promise<Res> {
  return json(200, {
    settings: currentSettings(),
    industries: Object.values(INDUSTRIES).map((i) => ({ id: i.id, label: i.label, description: i.description })),
    regions: Object.values(REGIONS).map((r) => ({ id: r.id, label: r.label })),
    templates: templatesFor(config().industry),
  });
}

/** One-time onboarding (can be re-run). { company, agentName, industry, region, businessDescription, clerks: [{ name, phone }] } */
export async function postSetup(req: Req): Promise<Res> {
  const b = req.json || {};
  const company = String(b.company || '').trim();
  const agentName = String(b.agentName || '').trim() || 'Asha';
  const industry = String(b.industry || '');
  const region = String(b.region || 'IN');
  if (!company) return json(400, { error: 'Company name is required.' });
  if (!(industry in INDUSTRIES)) return json(400, { error: 'Pick an industry.' });
  if (!(region in REGIONS)) return json(400, { error: 'Pick a region.' });
  // Normalise clerk numbers with the chosen region's country code.
  const prevCode = config().defaultCountryCode;
  config().defaultCountryCode = REGIONS[region as keyof typeof REGIONS].defaultCountryCode;
  const clerks = (Array.isArray(b.clerks) ? b.clerks : [])
    .map((c: any) => ({ name: String(c?.name || '').trim(), phone: normalizePhone(String(c?.phone || '')) }))
    .filter((c: { name: string; phone: string }) => c.name || c.phone);
  config().defaultCountryCode = prevCode;
  const bad = clerks.find((c: { name: string; phone: string }) => !c.name || !isE164(c.phone));
  if (bad) return json(400, { error: `Each clerk needs a name and a valid WhatsApp number (check "${bad.name || bad.phone}").` });
  const settings: Settings = {
    company: company.slice(0, 80),
    agentName: agentName.slice(0, 40),
    industry: industry as Settings['industry'],
    region: region as Settings['region'],
    businessDescription: String(b.businessDescription || INDUSTRIES[industry as keyof typeof INDUSTRIES].description).trim().slice(0, 300),
    dispatchers: clerks,
    setupAt: new Date().toISOString(),
  };
  await saveSettings(settings);
  applySettings(settings);
  return json(200, { ok: true, settings: currentSettings(), templates: templatesFor(settings.industry) });
}

// ------------------------------------------------------- prospect view (/watch)

/** Keep the country code and last 3 digits: +91 •••••••210. */
export function maskPhone(p?: string): string {
  if (!p) return p || '';
  const digits = p.replace(/\D/g, '');
  if (digits.length < 7) return p;
  const cc = p.startsWith('+') ? (p.match(/^\+(971|91|\d{1,3})/)?.[0] ?? '+') : '';
  return `${cc ? cc + ' ' : ''}${'•'.repeat(Math.max(3, digits.length - cc.replace('+', '').length - 3))}${digits.slice(-3)}`;
}
/** Hide phone numbers written inside messages and alerts too. */
export const maskText = (s?: string) => (s || '').replace(/\+?\d[\d\s-]{7,}\d/g, (m) => maskPhone(m));

/**
 * Read-only state for prospects: no key needed, demo mode only (live data is
 * never shown), phone numbers masked, nothing that can change state.
 */
export async function watchState(): Promise<Res> {
  if (!isDemo() || storeKind() !== 'memory') return json(404, { error: 'The live view is only available for demos.' });
  const full = JSON.parse((await state()).body);
  const person = (x: any) => (x ? { ...x, phone: maskPhone(x.phone) } : x);
  full.clerks = (full.clerks || []).map(person);
  full.deliveries = full.deliveries.map((d: any) => ({
    ...d,
    client: person(d.client),
    driver: person(d.driver),
    requestedBy: d.requestedBy ? maskPhone(d.requestedBy) : d.requestedBy,
    contacts: (d.contacts || []).map(person),
    site: { ...d.site, contact: d.site?.contact ? maskText(d.site.contact) : d.site?.contact },
    issue: d.issue ? maskText(d.issue) : d.issue,
  }));
  full.alerts = full.alerts.map((a: any) => ({ ...a, text: maskText(a.text) }));
  full.threads = full.threads.map((t: any) => ({ ...t, phone: maskPhone(t.phone), messages: t.messages.map((m: any) => ({ ...m, phone: maskPhone(m.phone), text: maskText(m.text) })) }));
  full.calls = full.calls.map((c: any) => ({ id: c.id, phone: maskPhone(c.phone), status: c.status, startedAt: c.startedAt }));
  delete full.sheet;
  delete full.store;
  full.view = true;
  return json(200, full);
}
