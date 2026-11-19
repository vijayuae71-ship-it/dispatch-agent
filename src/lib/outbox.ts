import { minutesBetween, now } from './clock';
import { appendMessage, getThread } from './store';
import { placeCall, sendWhatsApp } from './twilio';
import { renderTemplate, type TemplateName } from './templates';
import type { Party } from './types';

// Where outgoing messages and calls go.
//   live: Twilio WhatsApp + voice
//   demo: nothing leaves the server; messages appear in the console's phone view
//         and calls ring there, so a dispatch day can be shown without Twilio.

export const isDemo = () => process.env.MODE !== 'live';

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Send a free-form reply (inside the 24h window) or fall back to a template. */
export async function sendText(
  phone: string,
  text: string,
  meta: { party: Party; name?: string; deliveryIds?: string[] },
): Promise<SendResult> {
  try {
    if (!isDemo()) await sendWhatsApp(phone, { body: text });
    await appendMessage(phone, { party: meta.party, direction: 'out', channel: 'whatsapp', text, deliveryIds: meta.deliveryIds }, { name: meta.name, party: meta.party });
    return { ok: true };
  } catch (err: any) {
    console.error('outbox: send failed', err?.message);
    return { ok: false, error: err?.message };
  }
}

/** Start a conversation: template outside the 24h window, plain text inside it. */
export async function sendTemplate(
  phone: string,
  name: TemplateName,
  vars: string[],
  meta: { party: Party; name?: string; language?: string; deliveryIds?: string[] },
): Promise<SendResult> {
  const thread = await getThread(phone);
  const lang = meta.language || thread?.language;
  const { text, envKey } = renderTemplate(name, lang, vars);
  const inWindow = thread?.lastInboundAt && minutesBetween(thread.lastInboundAt, now()) < 24 * 60 - 5;
  try {
    if (!isDemo()) {
      if (inWindow) await sendWhatsApp(phone, { body: text });
      else {
        const sid = process.env[envKey] || process.env[envKey.replace(/_HI$/, '_EN')];
        if (!sid) throw new Error(`No approved WhatsApp template configured (${envKey}); can't start a conversation outside the 24h window`);
        await sendWhatsApp(phone, { contentSid: sid, variables: Object.fromEntries(vars.map((v, i) => [String(i + 1), v])) });
      }
    }
    await appendMessage(phone, { party: meta.party, direction: 'out', channel: 'whatsapp', text, deliveryIds: meta.deliveryIds }, { name: meta.name, party: meta.party, language: meta.language });
    return { ok: true };
  } catch (err: any) {
    console.error('outbox: template send failed', err?.message);
    return { ok: false, error: err?.message };
  }
}

/** Ring someone. In demo mode the console shows an incoming call instead. */
export async function ring(phone: string, callId: string): Promise<{ ok: boolean; twilioSid?: string; error?: string }> {
  if (isDemo()) return { ok: true };
  try {
    return { ok: true, twilioSid: await placeCall(phone, callId) };
  } catch (err: any) {
    console.error('outbox: call failed', err?.message);
    return { ok: false, error: err?.message };
  }
}
