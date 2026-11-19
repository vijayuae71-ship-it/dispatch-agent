import { createHmac, timingSafeEqual } from 'crypto';
import { config, resolveLanguage, type VoiceLanguage } from './config';

// Minimal Twilio helpers over plain HTTPS: no SDK dependency needed.

export function publicBaseUrl(): string {
  const url = process.env.PUBLIC_URL;
  if (!url) throw new Error('Set PUBLIC_URL to the public https URL of this service');
  return url.replace(/\/$/, '');
}

/** The relay WebSocket lives on the same service: wss://<PUBLIC_URL host>/relay */
export function relayUrl(): string {
  return publicBaseUrl().replace(/^http/, 'ws') + '/relay';
}

export const signatureChecksDisabled = () =>
  process.env.SKIP_SIGNATURE === 'true' && process.env.NODE_ENV !== 'production';

/**
 * Verify X-Twilio-Signature. Cloud Run rewrites the host, so the signed URL is
 * rebuilt from PUBLIC_URL + the request path and query.
 */
export function verifyTwilioSignature(
  pathAndQuery: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  if (!signature) return false;
  const url = publicBaseUrl() + pathAndQuery;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Check X-Twilio-Signature on a request with no body params (e.g. the relay WebSocket upgrade). */
export function verifySignatureForUrl(fullUrl: string, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const expected = createHmac('sha1', token).update(Buffer.from(fullUrl, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Check a form-encoded Twilio webhook. */
export function twilioRequestOk(pathAndQuery: string, params: Record<string, string>, signature: string | null): boolean {
  return signatureChecksDisabled() || verifyTwilioSignature(pathAndQuery, params, signature);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function langAttrs(l: VoiceLanguage): string {
  const a: [string, string | undefined][] = [
    ['ttsProvider', l.ttsProvider],
    ['voice', l.voice],
    ['transcriptionProvider', l.transcriptionProvider],
    ['speechModel', l.speechModel],
  ];
  return a
    .filter(([, v]) => v)
    .map(([k, v]) => ` ${k}="${esc(v!)}"`)
    .join('');
}

/** <Connect><ConversationRelay>: streaming voice with every configured language available mid-call. */
export function conversationRelayTwiml(callId: string, language: string): string {
  const cur = resolveLanguage(language);
  const languages = config()
    .languages.map((l) => resolveLanguage(l.code))
    .map((l) => `<Language code="${esc(l.code)}"${langAttrs(l)}/>`)
    .join('');
  return twiml(
    `<Connect action="${esc(publicBaseUrl() + '/twilio/handoff?call=' + encodeURIComponent(callId))}">` +
      `<ConversationRelay url="${esc(relayUrl())}" language="${esc(cur.code)}" ttsLanguage="${esc(cur.code)}" ` +
      `transcriptionLanguage="${esc(cur.transcriptionLanguage || cur.code)}"${langAttrs(cur)} interruptible="any" ` +
      `elevenlabsTextNormalization="on">` +
      languages +
      `<Parameter name="call" value="${esc(callId)}"/>` +
      `</ConversationRelay></Connect>`,
  );
}

// ------------------------------------------------------------- REST API

function creds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  return { sid, token, auth: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') };
}

async function twilioPost(path: string, body: URLSearchParams): Promise<any> {
  const { sid, auth } = creds();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`Twilio ${res.status}${json.code ? ` (${json.code})` : ''}: ${json.message || 'request failed'}`);
  return json;
}

/**
 * Send a WhatsApp message from the business sender (TWILIO_WHATSAPP_FROM).
 * Free-form text only works within 24h of the person's last message;
 * otherwise pass an approved template (Content SID + variables).
 */
export async function sendWhatsApp(
  to: string,
  msg: { body: string } | { contentSid: string; variables: Record<string, string> },
): Promise<string> {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error('TWILIO_WHATSAPP_FROM must be set, e.g. +14155238886');
  const body = new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}` });
  if ('body' in msg) body.set('Body', msg.body);
  else {
    body.set('ContentSid', msg.contentSid);
    body.set('ContentVariables', JSON.stringify(msg.variables));
  }
  if (process.env.PUBLIC_URL) body.set('StatusCallback', publicBaseUrl() + '/twilio/message-status');
  return String((await twilioPost('Messages.json', body)).sid);
}

/**
 * Place a voice call. With WHATSAPP_CALLS=true it calls the person's WhatsApp
 * (they must have given the business call permission); otherwise a normal
 * phone call from TWILIO_VOICE_FROM.
 */
export async function placeCall(to: string, callId: string): Promise<string> {
  const viaWhatsApp = process.env.WHATSAPP_CALLS === 'true';
  const from = viaWhatsApp ? process.env.TWILIO_WHATSAPP_FROM : process.env.TWILIO_VOICE_FROM;
  if (!from) throw new Error(viaWhatsApp ? 'TWILIO_WHATSAPP_FROM must be set' : 'TWILIO_VOICE_FROM must be set for phone calls');
  const q = `?call=${encodeURIComponent(callId)}`;
  const body = new URLSearchParams({
    To: viaWhatsApp ? `whatsapp:${to}` : to,
    From: viaWhatsApp ? `whatsapp:${from}` : from,
    Url: publicBaseUrl() + '/twilio/voice' + q,
    Method: 'POST',
    StatusCallback: publicBaseUrl() + '/twilio/call-status' + q,
    StatusCallbackMethod: 'POST',
    Timeout: '30',
  });
  for (const ev of ['answered', 'completed']) body.append('StatusCallbackEvent', ev);
  if (!viaWhatsApp) body.set('MachineDetection', 'Enable');
  return String((await twilioPost('Calls.json', body)).sid);
}

/** Twilio sends "whatsapp:+91…"; we store plain E.164. */
export const stripWhatsApp = (s: string) => s.replace(/^whatsapp:/, '');

/** Basic E.164 check: + then 8-15 digits. */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}
