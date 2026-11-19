/**
 * Twilio ConversationRelay WebSocket handler (mounted at /relay), for the
 * escalation calls the dispatcher places when WhatsApp gets no reply.
 *
 * Streams Claude's reply into text-to-speech token by token, handles barge-in,
 * and switches language mid-call. Same proven design as Sales-Agent's relay.
 */
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { resolveLanguage, type VoiceLanguage } from './lib/config';
import { getCall, saveCall } from './lib/store';
import { callDeliveries, endCall, recordVoiceTurn } from './lib/engine';
import { runVoiceTurn, type VoiceTurn } from './lib/agent';
import { relayUrl, signatureChecksDisabled, verifySignatureForUrl } from './lib/twilio';
import type { CallSession } from './lib/types';

const IDLE_MS = Number(process.env.IDLE_MS || 9000);

type Outbound =
  | { type: 'text'; token: string; last: boolean }
  | { type: 'language'; ttsLanguage: string; transcriptionLanguage: string }
  | { type: 'end'; handoffData?: string };

/** Rough time the TTS needs to finish speaking `text`, so we don't hang up mid-sentence. */
const speakingMs = (text: string) => Math.min(15_000, 1200 + (text.length / 14) * 1000);

class RelaySession {
  private call: CallSession | null = null;
  private current: { abort: AbortController } | null = null;
  private pendingInterrupt: string | undefined;
  private idle: NodeJS.Timeout | null = null;
  private lastSpokenAt = 0;
  private ended = false;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private silent = 0;

  constructor(private ws: WebSocket) {}

  private send(msg: Outbound) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'setup') return this.onSetup(msg);
    if (msg.type === 'prompt') {
      if (msg.last === false) return;
      this.silent = 0;
      return this.enqueue(String(msg.voicePrompt || ''));
    }
    if (msg.type === 'interrupt') return this.onInterrupt(String(msg.utteranceUntilInterrupt || ''));
    if (msg.type === 'error') console.error('relay: Twilio error', msg.description);
  }

  private async onSetup(msg: any) {
    const id = msg.customParameters?.call;
    const call = id ? await getCall(id) : null;
    if (!call) {
      console.error('relay: no call for', id);
      this.send({ type: 'text', token: 'Sorry, something went wrong. Dispatch will call you back.', last: true });
      return this.endSession(2500);
    }
    this.call = call;
    call.twilioSid = msg.callSid || call.twilioSid;
    call.status = 'in_progress';
    await saveCall(call);
    await this.enqueue(null); // the bot speaks first
  }

  private onInterrupt(heard: string) {
    if (!this.call) return;
    this.pendingInterrupt = heard;
    if (this.current) this.current.abort.abort();
    else {
      const last = this.call.transcript[this.call.transcript.length - 1];
      if (last?.role === 'bot') last.text = `${heard.trim()} [interrupted]`;
    }
  }

  private enqueue(speech: string | null) {
    if (!this.call || this.ended) return;
    this.clearIdle();
    this.current?.abort.abort();
    this.inFlight += 1;
    const p = this.queue
      .then(() => this.doTurn(speech))
      .finally(() => {
        this.inFlight -= 1;
        if (!this.ended) this.armIdle();
      });
    this.queue = p.catch(() => {});
    return p;
  }

  private async doTurn(speech: string | null) {
    const call = this.call;
    if (!call || this.ended) return;
    const interruptedAfter = this.pendingInterrupt;
    this.pendingInterrupt = undefined;
    const deliveries = await callDeliveries(call);
    const abort = new AbortController();
    this.current = { abort };
    let turn: VoiceTurn;
    try {
      turn = await runVoiceTurn(call, deliveries, speech === null ? { kind: 'open' } : { kind: 'speech', speech, interruptedAfter }, {
        signal: abort.signal,
        onText: (d) => {
          if (!abort.signal.aborted) this.send({ type: 'text', token: d, last: false });
        },
        onLanguage: (l: VoiceLanguage) =>
          this.send({ type: 'language', ttsLanguage: l.code, transcriptionLanguage: l.transcriptionLanguage || l.code }),
      });
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
    if (turn.aborted) {
      if (turn.text) call.transcript.push({ role: 'bot', text: `${turn.text.trim()} [interrupted]`, at: new Date().toISOString() });
      return;
    }
    this.send({ type: 'text', token: '', last: true });
    this.lastSpokenAt = Date.now() + speakingMs(turn.text);
    await recordVoiceTurn(call, speech, turn);
    if (turn.action === 'end') await this.endSession(speakingMs(turn.text));
  }

  private armIdle() {
    this.clearIdle();
    if (this.inFlight > 0 || this.ended) return;
    const wait = Math.max(0, this.lastSpokenAt - Date.now()) + IDLE_MS;
    this.idle = setTimeout(() => {
      this.silent += 1;
      if (this.silent >= 3) return this.endSession(0);
      this.enqueue('');
    }, wait);
  }

  private clearIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private async endSession(afterMs: number) {
    if (this.ended) return;
    this.ended = true;
    this.clearIdle();
    await new Promise((r) => setTimeout(r, afterMs));
    this.send({ type: 'end', handoffData: JSON.stringify({ call: this.call?.id, action: 'end' }) });
  }

  async onClose() {
    this.clearIdle();
    this.current?.abort.abort();
    if (this.call) await endCall(this.call.id, 'completed').catch((e) => console.error('relay: close', e));
  }
}

export function relaySignatureOk(req: IncomingMessage): boolean {
  if (signatureChecksDisabled()) return true;
  const sig = req.headers['x-twilio-signature'];
  const url = new URL(req.url || '/relay', relayUrl());
  return verifySignatureForUrl(url.toString(), typeof sig === 'string' ? sig : null);
}

export function attachRelay(ws: WebSocket) {
  const session = new RelaySession(ws);
  let chain = Promise.resolve();
  ws.on('message', (data) => {
    const text = data.toString();
    let type: string | undefined;
    try {
      type = JSON.parse(text)?.type;
    } catch {
      return;
    }
    if (type === 'interrupt' || type === 'prompt') session.onMessage(text).catch((e) => console.error('relay:', e));
    else chain = chain.then(() => session.onMessage(text)).catch((e) => console.error('relay:', e));
  });
  ws.on('close', () => {
    chain.then(() => session.onClose());
  });
}
