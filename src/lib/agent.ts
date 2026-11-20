import Anthropic from '@anthropic-ai/sdk';
import { config, findLanguage, resolveLanguage, type VoiceLanguage } from './config';
import { industryOf } from './industries';
import { fmtDateTime, fmtTime, now, tzOffset } from './clock';
import type { AgentAlert, CallSession, Delivery, DeliveryUpdate, Message, Party } from './types';

// The AI dispatcher.
//  - replyToMessage(): one WhatsApp message in → one reply + structured updates (structured outputs).
//  - runVoiceTurn():   one spoken turn on a call, streamed into text-to-speech.
//
// Claude Haiku 5.5 by default: these are short, routine exchanges, and cost per
// delivery has to stay low for the Indian market. Override with MODEL.

const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const EFFORT = (process.env.EFFORT || 'low') as 'low' | 'medium' | 'high';

let _client: Anthropic | undefined;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ timeout: 25_000, maxRetries: 1 });
  return _client;
}

const STATUSES = ['scheduled', 'confirmed', 'en_route', 'delayed', 'arrived', 'delivered', 'rescheduled', 'issue', 'cancelled'];

// ------------------------------------------------------------ shared context

function deliveryBrief(d: Delivery, party: Party | 'unknown'): string {
  const lines = [
    `- Delivery ${d.id}: order ${d.orderNo}, ${d.material}`,
    `  Deliver to: ${d.site.name}${d.site.area ? `, ${d.site.area}` : ''}${d.site.contact ? ` (contact at the location: ${d.site.contact})` : ''}`,
    `  Planned arrival: ${fmtDateTime(d.plannedAt)}; current ETA: ${d.eta ? fmtDateTime(d.eta) : 'same as planned'}`,
    `  Truck ${d.truck}; status: ${d.status}${d.lastLocation ? `; last known location: ${d.lastLocation}` : ''}`,
  ];
  if (party !== 'driver') {
    // Only the delivery's own client gets the driver's number, never an unknown caller.
    lines.push(`  Driver: ${d.driver.name}${party === 'client' && config().shareDriverPhone ? ` (phone ${d.driver.phone})` : ''}`);
  }
  else lines.push(`  Client: ${d.client.name}`);
  if (d.issue) lines.push(`  Open issue: ${d.issue}`);
  if (d.rescheduledTo) lines.push(`  Client asked to reschedule to: ${fmtDateTime(d.rescheduledTo)}`);
  return lines.join('\n');
}

/** Industry-specific vocabulary and what counts as urgent, from onboarding. */
function industryNotes(): string {
  const ind = industryOf(config().industry);
  return `Industry: ${ind.label}. ${ind.aiNotes}`;
}

function languagesList(): string {
  return config()
    .languages.map((l) => `${l.code} (${l.name})${l.style ? `: ${l.style}` : ''}`)
    .join('\n');
}

function roleGuide(party: Party | 'unknown'): string {
  if (party === 'driver')
    return `You are talking to a truck DRIVER. Drivers may be on the road: keep every message very short and simple. Find out where they are (a landmark, road or area is enough), their ETA to the delivery location, and any problem (breakdown, puncture, traffic jam, police check, loading delay, entry refused at the location, accident). Never ask them to type long answers. If they mention an accident, injury or breakdown, tell them dispatch will call them, and raise a critical alert. Remind them not to text while driving if they seem to be driving.`;
  if (party === 'client')
    return `You are talking to a CUSTOMER (or their staff at the delivery location: site, warehouse, store, plant…) receiving a delivery. Help them with: confirming they're ready to receive it, the contact person at the location, rescheduling, new orders, and "where is my truck?" questions (answer only from the delivery data: ETA, truck number, driver name, status${config().shareDriverPhone ? ", and the driver's phone number if they ask for it" : ''}). ${config().shareDriverPhone ? "If they ask for the driver's number, just give it; no alert is needed." : "You can't share the driver's phone number; offer to pass a message to the driver, and raise an info alert only if they insist on talking to him."} Never promise anything not in the data; for complaints, pricing, quality or billing say the dispatcher will call them and raise an alert.`;
  return `You don't know who this is. Politely say this number is for delivery updates and ask for their order number; raise an info alert so a dispatcher can follow up.`;
}

// --------------------------------------------------------------- WhatsApp

export interface NewOrder {
  /** What to deliver, in the customer's words, e.g. "OPC cement", "300 cartons biscuits". */
  what: string;
  /** Number of truck trips (1 if not said). */
  trips: number;
  /** Where to deliver. */
  location: string;
  /** When it's needed, ISO 8601 with offset. */
  requestedAt: string;
}

export interface TextReply {
  reply: string;
  language: string | null;
  updates: DeliveryUpdate[];
  alert: AgentAlert | null;
  newOrders: NewOrder[];
}

const UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliveryId', 'status', 'etaMinutes', 'location', 'issue', 'siteContact', 'rescheduleTo', 'confirmed'],
  properties: {
    deliveryId: { type: 'string' },
    status: { anyOf: [{ type: 'string', enum: STATUSES }, { type: 'null' }] },
    etaMinutes: { type: ['integer', 'null'], description: 'Minutes from now until the truck reaches the delivery location, if stated or clearly implied.' },
    location: { type: ['string', 'null'], description: 'Where the truck is now, as the driver described it.' },
    issue: { type: ['string', 'null'], description: 'A problem needing a human, in English, one line.' },
    siteContact: { type: ['string', 'null'], description: 'Contact person (name and number) at the delivery location, given by the customer.' },
    rescheduleTo: { type: ['string', 'null'], description: 'New requested delivery time as ISO 8601 with offset.' },
    confirmed: { type: ['boolean', 'null'], description: 'True if the customer confirmed they are ready to receive the delivery.' },
  },
} as const;

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'language', 'updates', 'alert', 'newOrders'],
  properties: {
    newOrders: {
      type: 'array',
      description: 'New orders placed in the latest message only. Empty if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'trips', 'location', 'requestedAt'],
        properties: {
          what: { type: 'string', description: 'What to deliver, in their words, e.g. "OPC cement" or "300 cartons biscuits".' },
          trips: { type: 'integer', description: 'Number of truck trips; 1 if not said.' },
          location: { type: 'string', description: 'Delivery location, matching a known location name when it is one.' },
          requestedAt: { type: 'string', description: 'When it is needed, ISO 8601 with offset.' },
        },
      },
    },
    reply: { type: 'string', description: 'The WhatsApp reply to send. Empty string if no reply is needed.' },
    language: { type: ['string', 'null'], description: 'Language code the person is writing in, from the list.' },
    updates: { type: 'array', items: UPDATE_SCHEMA },
    alert: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['deliveryId', 'severity', 'text'],
          properties: {
            deliveryId: { type: ['string', 'null'] },
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
            text: { type: 'string', description: 'For the dispatcher, in English, one or two lines.' },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

function textSystemPrompt(): string {
  const c = config();
  return `You are ${c.agentName}, the AI dispatch assistant of ${c.company}, a logistics company${c.businessDescription ? ` (${c.businessDescription})` : ''}. You handle WhatsApp messages with customers and truck drivers about deliveries. Use the words this business and its customers use for their goods and locations. You are helpful, warm and brief, like a good human dispatcher.

${industryNotes()}

How to write:
- WhatsApp style: short, friendly, plain. 1-3 short sentences. No markdown headings or bullet lists. At most one emoji, usually none.
- Reply in the language the person writes in. Many people mix Hindi and English (Hinglish) or write Indian languages in Roman script: mirror exactly how they write (if they write "kab tak aayega", reply in Roman-script Hinglish, not Devanagari).
- Use 12-hour times like "3:30 PM". Use truck numbers and order numbers exactly as in the data.
- Never invent facts. If you don't know, say the dispatcher will check and get back.
- You are an AI assistant. If asked, say so plainly.

Languages you can use:
${languagesList()}

Record what you learn in "updates", one entry per affected delivery, with null for anything not mentioned:
- Driver gives location and/or ETA → location, etaMinutes; status "en_route" (or "delayed" if clearly late), "arrived" if they're at the delivery location, "delivered" if unloaded / handed over.
- Customer confirms they're ready to receive → confirmed true, status "confirmed". Gives a contact person at the location → siteContact.
- Client wants a different time → rescheduleTo, status "rescheduled", and an info alert.
- Any problem a human must handle (breakdown, accident, delivery refused, wrong or damaged goods, complaint, cancellation request) → issue, status "issue", and an alert ("critical" for breakdown/accident/delivery refused, "warning" otherwise).
- Use only delivery IDs from the data. If the message doesn't change anything, return an empty updates list.
- New orders: customers may order on WhatsApp ("Send 2 trip OPC to Jebel Ali plant 3 PM", "need 300 cartons at Andheri store tomorrow 10 am"). Add one entry to newOrders only when the latest message places a new order and you know what, where and when (resolve "3 PM", "tomorrow morning" against the current time; "now/ASAP" means one hour from now). If something is missing, ask for it briefly instead and add nothing. When you add a new order, set reply to "" because the system sends a numbered confirmation. Never re-add an order from earlier in the conversation. Unknown numbers can't order: ask who they are.
- Raise an alert only when a human must act. Don't raise one for something you handled yourself, or repeat one you already raised in this conversation for the same problem.`;
}

/**
 * Reply to one inbound WhatsApp message. `history` is the recent thread
 * (oldest first) and already includes the new message as the last item.
 */
export async function replyToMessage(input: {
  party: Party | 'unknown';
  name?: string;
  deliveries: Delivery[];
  history: Message[];
  /** For customers: their usual delivery locations, so new orders use consistent names. */
  knownLocations?: string[];
}): Promise<TextReply> {
  const { party, name, deliveries, history, knownLocations } = input;
  const convo = history
    .slice(-16)
    .map((m) => `[${fmtTime(m.at)}] ${m.direction === 'in' ? name || 'Them' : 'You'}${m.channel === 'call' ? ' (on a call)' : ''}: ${m.text}`)
    .join('\n');
  const user = `Current time: ${fmtDateTime(now().toISOString())} (UTC${tzOffset()}).

${roleGuide(party)}

Person: ${name || 'unknown'} (${party})
Their deliveries:
${deliveries.length ? deliveries.map((d) => deliveryBrief(d, party)).join('\n') : '(no active deliveries)'}${knownLocations?.length ? `\nTheir usual delivery locations: ${knownLocations.join('; ')}` : ''}

Conversation so far (latest last):
${convo}

Write your reply to their latest message.`;

  const fallback: TextReply = {
    reply: party === 'driver' ? 'Thanks, noted. Dispatch will call you shortly.' : 'Thank you. Our dispatcher will get back to you shortly.',
    language: null,
    updates: [],
    alert: { deliveryId: deliveries[0]?.id || null, severity: 'warning', text: `AI couldn't handle a message from ${name || 'unknown'} (${party}); please read the thread.` },
    newOrders: [],
  };

  try {
    const res = await client().messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: REPLY_SCHEMA } },
      system: [{ type: 'text', text: textSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      console.warn('agent: unusable reply', res.stop_reason);
      return fallback;
    }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const p = JSON.parse(text) as TextReply;
    const ids = new Set(deliveries.map((d) => d.id));
    return {
      reply: String(p.reply || '').trim(),
      language: p.language && findLanguage(p.language) ? findLanguage(p.language)!.code : null,
      updates: (p.updates || []).filter((u) => ids.has(u.deliveryId)),
      newOrders:
        party === 'client'
          ? (p.newOrders || [])
              .filter((o) => o && o.what && o.location && !isNaN(Date.parse(o.requestedAt)))
              .map((o) => ({ ...o, trips: Math.max(1, Math.min(20, Math.round(Number(o.trips) || 1))) }))
          : [],
      alert: p.alert && p.alert.text ? { ...p.alert, deliveryId: p.alert.deliveryId && ids.has(p.alert.deliveryId) ? p.alert.deliveryId : deliveries[0]?.id || null } : null,
    };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.error('agent: rate limited');
    else if (err instanceof Anthropic.APIError) console.error(`agent: API error ${err.status}`, err.message);
    else console.error('agent: reply failed', err);
    return fallback;
  }
}

// ------------------------------------------------------------------ voice

/**
 * Splits streamed output into an optional [[lang]] tag, spoken text, and a
 * trailing <<<json>>> metadata line, holding back partial markers.
 */
export class OutputSplitter {
  private buf = '';
  private phase: 'start' | 'speech' | 'meta' = 'start';
  meta = '';
  spoken = '';
  constructor(
    private emit: (s: string) => void,
    private onTag: (code: string) => void,
  ) {}
  push(delta: string) {
    this.buf += delta;
    this.drain(false);
  }
  end() {
    this.drain(true);
  }
  private drain(final: boolean) {
    if (this.phase === 'start') {
      const t = this.buf.trimStart();
      if (t.startsWith('[[')) {
        const close = t.indexOf(']]');
        if (close === -1) {
          if (!final && t.length < 20) return;
        } else {
          this.onTag(t.slice(2, close).trim());
          this.buf = t.slice(close + 2).trimStart();
        }
      } else if (!final && t.length < 2 && '[['.startsWith(t)) {
        return;
      } else {
        this.buf = t;
      }
      this.phase = 'speech';
    }
    if (this.phase === 'speech') {
      const at = this.buf.indexOf('<<<');
      if (at !== -1) {
        this.say(this.buf.slice(0, at));
        this.meta = this.buf.slice(at + 3);
        this.buf = '';
        this.phase = 'meta';
        return;
      }
      const m = final ? null : this.buf.match(/<{1,2}$/);
      const cut = m ? this.buf.length - m[0].length : this.buf.length;
      this.say(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      return;
    }
    this.meta += this.buf;
    this.buf = '';
  }
  private say(s: string) {
    if (!s) return;
    const out = this.spoken ? s : s.replace(/^\s+/, '');
    if (!out) return;
    this.spoken += out;
    this.emit(out);
  }
}

function voiceSystemPrompt(): string {
  const c = config();
  return `You are ${c.agentName}, the AI dispatch assistant of ${c.company}, on a live phone call. What you write is spoken aloud by text-to-speech the moment you write it, and the person's words reach you through speech recognition, which makes mistakes.

How to speak:
- Like a friendly, efficient Indian dispatcher: short sentences, everyday words, one question at a time. Most replies under 20 words.
- Speak the person's language; switch when they do. Hindi speakers often mix English words: do the same. Write Hindi and other Indian languages in their native script so the voice pronounces them correctly.
- Say truck numbers slowly in groups ("M H one two, A B, four eight two one"), times as "three thirty PM".
- Drivers may be driving: keep it very brief and finish fast.
- Never invent facts. If you don't know, say the dispatcher will call back.
- You are an AI assistant; say so if asked. Never claim to be human.

${industryNotes()}

Languages:
${languagesList()}

Output format (strict):
1. Only when switching language: the tag [[code]] first, e.g. [[hi-IN]].
2. What to say out loud.
3. On a new line: <<<{"updates": [...], "alert": null, "action": "continue"}>>>
   - updates: same fields as below, one per affected delivery: {"deliveryId", "status", "etaMinutes", "location", "issue", "siteContact", "rescheduleTo", "confirmed"}, null for unknown fields. [] if nothing changed.
   - alert: null, or {"deliveryId", "severity": "info"|"warning"|"critical", "text"} for anything a human must handle.
   - action: "continue", or "end" once you've got what you need and said a short goodbye.
The metadata line is never spoken.`;
}

function voiceUserTurn(call: CallSession, deliveries: Delivery[], input: { kind: 'open' } | { kind: 'speech'; speech: string; interruptedAfter?: string }): Anthropic.MessageParam {
  const blocks: Anthropic.TextBlockParam[] = [];
  if (call.messages.length === 0) {
    blocks.push({
      type: 'text',
      text: `${roleGuide(call.party)}\n\nWhy you're calling: ${call.reason}.\nCurrent time: ${fmtDateTime(now().toISOString())}.\nDeliveries:\n${deliveries.map((d) => deliveryBrief(d, call.party)).join('\n')}`,
    });
  }
  if (input.kind === 'open') {
    const lang = resolveLanguage(call.language);
    blocks.push({
      type: 'text',
      text: `They just picked up. In ${lang.name}: greet them by name, say you're the AI assistant from ${config().company} dispatch, and ask your question. Keep it to two short sentences.`,
    });
  } else {
    const earlier = (call.pendingCaller || []).map((t) => `They said: "${t}"`).join('\n');
    if (earlier) blocks.push({ type: 'text', text: `Earlier, before you could reply:\n${earlier}` });
    const cut = input.interruptedAfter ? `(They cut you off. They only heard: "${input.interruptedAfter}")\n\n` : '';
    blocks.push({ type: 'text', text: `Turn ${call.turns + 1}${call.turns >= 7 ? ' (wrap up now)' : ''}.\n${cut}They said: "${input.speech || '(silence / unclear)'}"` });
  }
  return { role: 'user', content: blocks };
}

export interface VoiceTurn {
  text: string;
  updates: DeliveryUpdate[];
  alert: AgentAlert | null;
  action: 'continue' | 'end';
  aborted: boolean;
}

export async function runVoiceTurn(
  call: CallSession,
  deliveries: Delivery[],
  input: { kind: 'open' } | { kind: 'speech'; speech: string; interruptedAfter?: string },
  io: { onText?: (s: string) => void; onLanguage?: (l: VoiceLanguage) => void; signal?: AbortSignal } = {},
): Promise<VoiceTurn> {
  const user = voiceUserTurn(call, deliveries, input);
  const splitter = new OutputSplitter(
    (s) => io.onText?.(s),
    (code) => {
      const l = findLanguage(code);
      if (l && l.code !== call.language) {
        call.language = l.code;
        io.onLanguage?.(resolveLanguage(l.code));
      }
    },
  );
  const fallbackLine = 'Sorry, the line is unclear. Dispatch will call you back shortly.';
  let final: Anthropic.Message;
  try {
    const stream = client().messages.stream(
      {
        model: MODEL,
        max_tokens: 2000,
        // Phone replies need the fastest first word: no extended thinking.
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: voiceSystemPrompt(), cache_control: { type: 'ephemeral' } }],
        messages: [...(call.messages as Anthropic.MessageParam[]), user],
      },
      { signal: io.signal },
    );
    stream.on('text', (d) => splitter.push(d));
    final = await stream.finalMessage();
    splitter.end();
  } catch (err) {
    if (io.signal?.aborted) {
      if (input.kind === 'speech' && input.speech) call.pendingCaller = [...(call.pendingCaller || []), input.speech];
      return { text: splitter.spoken, updates: [], alert: null, action: 'continue', aborted: true };
    }
    console.error('agent: voice turn failed', err);
    if (!splitter.spoken) io.onText?.(fallbackLine);
    return {
      text: splitter.spoken || fallbackLine,
      updates: [],
      alert: { deliveryId: deliveries[0]?.id || null, severity: 'warning', text: `Call to ${call.party} failed mid-way; please follow up.` },
      action: 'end',
      aborted: false,
    };
  }

  call.messages.push(user, { role: 'assistant', content: final.content });
  call.pendingCaller = [];
  call.turns += 1;

  let meta: { updates?: DeliveryUpdate[]; alert?: AgentAlert | null; action?: string } = {};
  try {
    meta = JSON.parse(splitter.meta.replace(/>>>[\s\S]*$/, '').trim() || '{}');
  } catch {
    /* no or bad metadata: keep talking */
  }
  const ids = new Set(deliveries.map((d) => d.id));
  let text = splitter.spoken.trim();
  if (final.stop_reason === 'refusal' || !text) {
    text = text || fallbackLine;
    if (!splitter.spoken) io.onText?.(text);
  }
  const action = meta.action === 'end' || call.turns >= 10 ? 'end' : 'continue';
  return {
    text,
    updates: (meta.updates || []).filter((u) => u && ids.has(u.deliveryId)).map(normaliseUpdate),
    alert: meta.alert && meta.alert.text ? meta.alert : null,
    action,
    aborted: false,
  };
}

function normaliseUpdate(u: Partial<DeliveryUpdate> & { deliveryId: string }): DeliveryUpdate {
  return {
    deliveryId: u.deliveryId,
    status: u.status && STATUSES.includes(u.status) ? u.status : null,
    etaMinutes: typeof u.etaMinutes === 'number' && isFinite(u.etaMinutes) ? Math.round(u.etaMinutes) : null,
    location: u.location || null,
    issue: u.issue || null,
    siteContact: u.siteContact || null,
    rescheduleTo: u.rescheduleTo || null,
    confirmed: typeof u.confirmed === 'boolean' ? u.confirmed : null,
  };
}
