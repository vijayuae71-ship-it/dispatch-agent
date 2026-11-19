import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Company settings live in config/dispatch.json (see the example there).
// Every timing can also be overridden by an environment variable.

export interface VoiceLanguage {
  code: string;
  name: string;
  ttsProvider?: 'ElevenLabs' | 'Google' | 'Amazon';
  voice?: string;
  transcriptionProvider?: 'Deepgram' | 'Google';
  transcriptionLanguage?: string;
  speechModel?: string;
  style?: string;
}

export interface DispatchConfig {
  company: string;
  /** Name the assistant uses, e.g. "Asha from Sharma Logistics dispatch". */
  agentName: string;
  timezone: string;
  /** Default language for outgoing messages when a contact has none set. */
  defaultLanguage: string;
  /** WhatsApp numbers (E.164) that receive alerts. */
  dispatchers: { name: string; phone: string }[];
  rules: {
    /** Ask the client to confirm this many minutes before planned arrival. */
    clientConfirmLeadMin: number;
    /** No reply on WhatsApp after this long → call (if enabled) or alert. */
    noReplyMin: number;
    /** Check with the driver if the ETA is this close or has passed. */
    driverCheckBeforeEtaMin: number;
    /** Ask the driver again if there has been no update for this long. */
    driverStaleMin: number;
    /** Alert the dispatcher when the ETA is this much later than planned. */
    lateThresholdMin: number;
  };
  /** Place voice calls when WhatsApp gets no reply. */
  callsEnabled: boolean;
  languages: VoiceLanguage[];
}

const DEFAULTS: DispatchConfig = {
  company: 'Demo Logistics',
  agentName: 'Asha',
  timezone: 'Asia/Kolkata',
  defaultLanguage: 'en-IN',
  dispatchers: [],
  rules: {
    clientConfirmLeadMin: 120,
    noReplyMin: 20,
    driverCheckBeforeEtaMin: 15,
    driverStaleMin: 90,
    lateThresholdMin: 45,
  },
  callsEnabled: true,
  languages: [],
};

let cached: DispatchConfig | null = null;

export function loadConfig(path = process.env.CONFIG_FILE || 'config/dispatch.json'): DispatchConfig {
  const file = resolve(path);
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: DispatchConfig = {
    ...DEFAULTS,
    ...fromFile,
    rules: { ...DEFAULTS.rules, ...(fromFile.rules || {}) },
  };
  const num = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  cfg.rules.clientConfirmLeadMin = num('CLIENT_CONFIRM_LEAD_MIN') ?? cfg.rules.clientConfirmLeadMin;
  cfg.rules.noReplyMin = num('NO_REPLY_MIN') ?? cfg.rules.noReplyMin;
  if (process.env.COMPANY_NAME) cfg.company = process.env.COMPANY_NAME;
  if (process.env.DISPATCHER_NUMBERS) {
    cfg.dispatchers = process.env.DISPATCHER_NUMBERS.split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((phone, i) => ({ name: `Dispatcher ${i + 1}`, phone }));
  }
  if (process.env.CALLS_ENABLED) cfg.callsEnabled = process.env.CALLS_ENABLED === 'true';
  cached = cfg;
  return cfg;
}

export function config(): DispatchConfig {
  return cached || loadConfig();
}

export function findLanguage(code?: string | null): VoiceLanguage | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase();
  const langs = config().languages;
  return langs.find((l) => l.code.toLowerCase() === c) || langs.find((l) => l.code.toLowerCase().split('-')[0] === c.split('-')[0]);
}

const DEFAULT_ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || 'UgBBYS2sOqTuMpoF3BR0-flash_v2_5-1.0_0.5_0.8';

export function resolveLanguage(code?: string | null): VoiceLanguage {
  const lang = findLanguage(code) || findLanguage(config().defaultLanguage) || config().languages[0] || { code: 'en-IN', name: 'English' };
  const ttsProvider = lang.ttsProvider || 'ElevenLabs';
  return {
    ...lang,
    ttsProvider,
    voice: lang.voice || (ttsProvider === 'ElevenLabs' ? DEFAULT_ELEVENLABS_VOICE : undefined),
    transcriptionProvider: lang.transcriptionProvider || 'Deepgram',
  };
}
