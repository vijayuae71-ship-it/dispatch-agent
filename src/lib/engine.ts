import { randomUUID } from 'crypto';
import { config } from './config';
import { minutesBetween, now, nowIso } from './clock';
import { decide, type Action } from './rules';
import { replyToMessage, runVoiceTurn, type VoiceTurn } from './agent';
import { isDemo, ring, sendTemplate, sendText } from './outbox';
import { statusPhrase, templateVars } from './templates';
import { handleClerkMessage, notifyClerks } from './clerks';
import {
  addAlert,
  listAlerts,
  appendMessage,
  getCall,
  getDelivery,
  getThread,
  listDeliveries,
  saveCall,
  saveDelivery,
  setThreadLanguage,
} from './store';
import { CLOSED, type AgentAlert, type CallSession, type Delivery, type DeliveryUpdate, type Party } from './types';

// The dispatcher's brain: reacts to incoming WhatsApp messages and calls,
// runs the time-based rules, and keeps every delivery's status current.

const digits = (p: string) => p.replace(/\D/g, '').slice(-10);
const samePhone = (a?: string, b?: string) => !!a && !!b && digits(a) === digits(b);

/** One write at a time per delivery, so a message and a rule tick can't overwrite each other. */
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function isActive(d: Delivery): boolean {
  if (CLOSED.includes(d.status)) return false;
  const mins = minutesBetween(now(), d.plannedAt);
  return mins > -24 * 60 && mins < 48 * 60;
}

/** Who is this number, and which of their deliveries are live? */
export async function identify(phone: string): Promise<{ party: Party | 'unknown'; name?: string; language?: string; deliveries: Delivery[] }> {
  const all = (await listDeliveries()).filter(isActive);
  const asDriver = all.filter((d) => samePhone(d.driver.phone, phone));
  if (asDriver.length) return { party: 'driver', name: asDriver[0].driver.name, language: asDriver[0].driver.language, deliveries: asDriver };
  const asClient = all.filter((d) => samePhone(d.client.phone, phone) || (d.contacts || []).some((c) => samePhone(c.phone, phone)));
  if (asClient.length) {
    const d = asClient[0];
    const c = samePhone(d.client.phone, phone) ? d.client : (d.contacts || []).find((x) => samePhone(x.phone, phone))!;
    const name = c === d.client ? c.name : `${c.name}${c.role ? ` (${c.role})` : ''}, ${d.client.name}`;
    return { party: 'client', name, language: c.language, deliveries: asClient };
  }
  const disp = config().dispatchers.find((x) => samePhone(x.phone, phone));
  if (disp) return { party: 'dispatcher', name: disp.name, deliveries: [] };
  return { party: 'unknown', deliveries: [] };
}

// ------------------------------------------------------------------ alerts

const SEVERITY = { info: 0, warning: 1, critical: 2 } as const;

/**
 * AI-raised alerts can repeat as a conversation goes on ("please call me",
 * "call me back"). Skip one if an open alert for the same delivery, at the
 * same or higher severity, was raised in the last 30 minutes.
 */
async function isDuplicate(a: AgentAlert): Promise<boolean> {
  if (!a.deliveryId) return false;
  const recent = await listAlerts(50);
  return recent.some(
    (x) =>
      !x.resolved &&
      x.deliveryId === a.deliveryId &&
      SEVERITY[x.severity] >= SEVERITY[a.severity] &&
      minutesBetween(x.at, now()) < 30,
  );
}

export async function raiseAlert(a: AgentAlert, opts: { dedupe?: boolean } = {}) {
  if (opts.dedupe && (await isDuplicate(a))) return null;
  const alert = await addAlert({ deliveryId: a.deliveryId || undefined, severity: a.severity, text: a.text });
  // Every alert goes to every clerk on WhatsApp; one of them takes it.
  await notifyClerks(alert);
  return alert;
}

// ---------------------------------------------------------- applying updates

/** Everyone on the client side of a delivery: the main contact plus site engineers, purchase managers… */
export function clientContacts(d: Delivery) {
  return [d.client, ...(d.contacts || [])].filter((c, i, all) => c.phone && all.findIndex((x) => samePhone(x.phone, c.phone)) === i);
}

const ANNOUNCED = ['delayed', 'arrived', 'delivered'] as const;

/** Tell every client contact when a truck runs late, arrives or is delivered: what the WhatsApp group used to do. */
async function announceStatus(d: Delivery) {
  const status = d.status as (typeof ANNOUNCED)[number];
  if (!ANNOUNCED.includes(status) || d.flags.notifiedStatus === status) return;
  d.flags.notifiedStatus = status;
  await saveDelivery(d);
  for (const c of clientContacts(d)) {
    const phrase = statusPhrase(status, d, c.language);
    await sendTemplate(c.phone, 'client_update', templateVars('client_update', d, phrase), {
      party: 'client',
      name: c === d.client ? c.name : `${c.name}${c.role ? ` (${c.role})` : ''}, ${d.client.name}`,
      language: c.language,
      deliveryIds: [d.id],
    });
  }
}

/** Apply what the AI learned to the delivery records. Returns a short log of changes. */
export async function applyUpdates(updates: DeliveryUpdate[], party: Party | 'unknown'): Promise<string[]> {
  const log: string[] = [];
  const toAnnounce: string[] = [];
  for (const u of updates) {
    await withLock(async () => {
      const d = await getDelivery(u.deliveryId);
      if (!d) return;
      const t = nowIso();
      if (party === 'driver' && (u.location || u.etaMinutes !== null || u.status)) d.lastDriverUpdateAt = t;
      if (u.location) d.lastLocation = u.location;
      if (u.etaMinutes !== null && u.etaMinutes >= 0 && u.etaMinutes < 24 * 60) {
        d.eta = new Date(now().getTime() + u.etaMinutes * 60_000).toISOString();
      }
      if (u.siteContact) d.site.contact = u.siteContact;
      if (u.confirmed) d.clientConfirmedAt = t;
      if (u.rescheduleTo && !isNaN(Date.parse(u.rescheduleTo))) d.rescheduledTo = new Date(u.rescheduleTo).toISOString();
      if (u.issue) d.issue = u.issue;

      let status = u.status ?? d.status;
      // Keep status consistent with the facts, whatever the model said.
      if (u.confirmed && d.status === 'scheduled' && !u.status) status = 'confirmed';
      if (party === 'driver' && (status === 'en_route' || status === 'delayed') && d.eta) {
        status = minutesBetween(d.plannedAt, d.eta) >= config().rules.lateThresholdMin / 2 ? 'delayed' : 'en_route';
      }
      if (u.issue) status = 'issue';
      if (status !== d.status) {
        log.push(`${d.orderNo}: ${d.status} → ${status}`);
        toAnnounce.push(d.id);
      }
      d.status = status;
      await saveDelivery(d);
    });
  }
  for (const id of toAnnounce) {
    const d = await getDelivery(id);
    if (d) await announceStatus(d);
  }
  return log;
}

// ---------------------------------------------------------------- WhatsApp

/** Handle one incoming WhatsApp message. Returns the reply that was sent (if any). */
export async function handleInbound(phone: string, text: string, opts: { hasMedia?: boolean } = {}): Promise<{ reply: string; party: string; changes: string[] }> {
  const who = await identify(phone);
  const body = text.trim() || (opts.hasMedia ? '(sent a voice note / attachment)' : '');
  await appendMessage(phone, { party: who.party, direction: 'in', channel: 'whatsapp', text: body, deliveryIds: who.deliveries.map((d) => d.id) }, { name: who.name, party: who.party });

  if (who.party === 'dispatcher') {
    const reply = await handleClerkMessage(phone, who.name || 'Clerk', body);
    return { reply, party: who.party, changes: [] };
  }
  if (opts.hasMedia && !text.trim()) {
    // Voice notes aren't transcribed yet: ask for text, and flag it.
    const msg = who.party === 'driver' ? 'Voice note mila, lekin abhi sun nahi sakte. Kripya type karke bhejein: abhi kahan ho, kitne baje pahunchoge?' : 'Thanks! I can only read text messages for now. Please type your message.';
    await sendText(phone, msg, { party: who.party === 'unknown' ? 'client' : who.party, name: who.name, deliveryIds: who.deliveries.map((d) => d.id) });
    return { reply: msg, party: who.party, changes: [] };
  }

  const thread = await getThread(phone);
  const r = await replyToMessage({ party: who.party, name: who.name, deliveries: who.deliveries, history: thread?.messages || [] });
  if (r.language) await setThreadLanguage(phone, r.language);
  const changes = await applyUpdates(r.updates, who.party);
  if (r.alert) await raiseAlert(r.alert, { dedupe: true });
  if (r.reply) {
    await sendText(phone, r.reply, { party: who.party === 'unknown' ? 'client' : who.party, name: who.name, deliveryIds: who.deliveries.map((d) => d.id) });
  }
  return { reply: r.reply, party: who.party, changes };
}

// ------------------------------------------------------------------- rules

/** Run the dispatch rules once. Called every minute, and after the demo clock moves. */
export async function tick(): Promise<Action[]> {
  const deliveries = await listDeliveries();
  const actions = decide(deliveries, now(), config());
  for (const a of actions) {
    try {
      await execute(a);
    } catch (err) {
      console.error('engine: action failed', a.kind, err);
    }
  }
  return actions;
}

async function execute(a: Action) {
  const d = await getDelivery(a.deliveryId);
  if (!d) return;
  const t = nowIso();
  if (a.kind === 'ask_client_confirm') {
    const r = await sendTemplate(d.client.phone, 'client_confirm', templateVars('client_confirm', d), { party: 'client', name: d.client.name, language: d.client.language, deliveryIds: [d.id] });
    d.flags.clientAskedAt = t;
    await saveDelivery(d);
    if (!r.ok) await raiseAlert({ deliveryId: d.id, severity: 'warning', text: `Couldn't message ${d.client.name} for order ${d.orderNo}: ${r.error}` });
  } else if (a.kind === 'ask_driver_eta') {
    const r = await sendTemplate(d.driver.phone, 'driver_eta', templateVars('driver_eta', d), { party: 'driver', name: d.driver.name, language: d.driver.language, deliveryIds: [d.id] });
    d.flags.driverAskedAt = t;
    await saveDelivery(d);
    if (!r.ok) await raiseAlert({ deliveryId: d.id, severity: 'warning', text: `Couldn't message driver ${d.driver.name} for order ${d.orderNo}: ${r.error}` });
  } else if (a.kind === 'call') {
    if (a.party === 'client') d.flags.clientCalledAt = t;
    else d.flags.driverCalledAt = t;
    await saveDelivery(d);
    await startCall(a.party, d, a.reason);
  } else if (a.kind === 'alert') {
    d.flags[a.flag] = t;
    await saveDelivery(d);
    await raiseAlert({ deliveryId: d.id, severity: a.severity, text: a.text });
  }
}

// ------------------------------------------------------------------- calls

export async function startCall(party: 'client' | 'driver', d: Delivery, reason: string): Promise<CallSession> {
  const contact = party === 'client' ? d.client : d.driver;
  const thread = await getThread(contact.phone);
  const call: CallSession = {
    id: randomUUID(),
    phone: contact.phone,
    party,
    deliveryIds: [d.id],
    reason,
    language: thread?.language || contact.language || config().defaultLanguage,
    status: 'ringing',
    messages: [],
    transcript: [],
    turns: 0,
    startedAt: nowIso(),
  };
  await saveCall(call);
  await appendMessage(contact.phone, { party, direction: 'out', channel: 'system', text: `📞 Calling ${contact.name}: ${reason}`, deliveryIds: [d.id] }, { name: contact.name, party });
  const r = await ring(contact.phone, call.id);
  if (!r.ok) {
    call.status = 'failed';
    await saveCall(call);
    await raiseAlert({ deliveryId: d.id, severity: 'warning', text: `Couldn't call ${contact.name} (${party}) for order ${d.orderNo}: ${r.error}` });
  } else if (r.twilioSid) {
    call.twilioSid = r.twilioSid;
    await saveCall(call);
  }
  return call;
}

export async function callDeliveries(call: CallSession): Promise<Delivery[]> {
  const out: Delivery[] = [];
  for (const id of call.deliveryIds) {
    const d = await getDelivery(id);
    if (d) out.push(d);
  }
  return out;
}

/** Record a finished voice turn: transcript, updates, alerts. */
export async function recordVoiceTurn(call: CallSession, heard: string | null, turn: VoiceTurn) {
  const t = nowIso();
  if (heard) call.transcript.push({ role: 'person', text: heard, at: t });
  if (turn.text) call.transcript.push({ role: 'bot', text: turn.text, at: t });
  const contactPhone = call.phone;
  if (heard) await appendMessage(contactPhone, { party: call.party, direction: 'in', channel: 'call', text: heard, deliveryIds: call.deliveryIds });
  if (turn.text) await appendMessage(contactPhone, { party: call.party, direction: 'out', channel: 'call', text: turn.text, deliveryIds: call.deliveryIds });
  await applyUpdates(turn.updates, call.party);
  if (turn.alert) await raiseAlert({ ...turn.alert, deliveryId: turn.alert.deliveryId || call.deliveryIds[0] || null }, { dedupe: true });
  if (turn.action === 'end') {
    call.status = 'completed';
    call.endedAt = t;
  } else call.status = 'in_progress';
  await saveCall(call);
}

/**
 * Demo mode: the console "answers" the call and types instead of speaking.
 * Same voice agent as a real call, just without streaming audio.
 */
export async function demoCallTurn(callId: string, speech: string | null): Promise<CallSession> {
  if (!isDemo()) throw new Error('Only available in demo mode');
  const call = await getCall(callId);
  if (!call) throw new Error('Call not found');
  if (call.status === 'completed' || call.status === 'failed') return call;
  const deliveries = await callDeliveries(call);
  const turn = await runVoiceTurn(call, deliveries, speech === null ? { kind: 'open' } : { kind: 'speech', speech });
  await recordVoiceTurn(call, speech, turn);
  return call;
}

export async function endCall(callId: string, status: CallSession['status'] = 'completed') {
  const call = await getCall(callId);
  if (!call || call.status === 'completed' || call.status === 'failed') return;
  call.status = status;
  call.endedAt = nowIso();
  await saveCall(call);
  if (status === 'failed' || call.transcript.length === 0) {
    await appendMessage(call.phone, { party: call.party, direction: 'out', channel: 'system', text: '📞 Call not answered', deliveryIds: call.deliveryIds });
  }
}
