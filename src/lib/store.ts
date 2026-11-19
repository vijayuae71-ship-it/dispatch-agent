import { randomUUID } from 'crypto';
import type { Alert, CallSession, Delivery, Message, Party, Thread } from './types';
import { nowIso } from './clock';

// Storage for deliveries, WhatsApp threads, alerts and calls.
//   STORE=firestore (default)  Google Firestore via firebase-admin
//   STORE=memory               in-process: demo mode, local development, tests
//
// Firestore collections: deliveries/{id}, threads/{phone}, alerts/{id}, calls/{id}.

interface Backend {
  get(col: string, id: string): Promise<any | null>;
  set(col: string, id: string, data: object): Promise<void>;
  list(col: string, orderBy: string, limit: number): Promise<any[]>;
  clear(): Promise<void>;
}

class MemoryBackend implements Backend {
  private cols = new Map<string, Map<string, any>>();
  private col(c: string) {
    if (!this.cols.has(c)) this.cols.set(c, new Map());
    return this.cols.get(c)!;
  }
  async get(c: string, id: string) {
    const v = this.col(c).get(id);
    return v ? structuredClone(v) : null;
  }
  async set(c: string, id: string, data: object) {
    this.col(c).set(id, structuredClone(data));
  }
  async list(c: string, orderBy: string, limit: number) {
    return [...this.col(c).values()]
      .sort((a, b) => String(b[orderBy] ?? '').localeCompare(String(a[orderBy] ?? '')))
      .slice(0, limit)
      .map((v) => structuredClone(v));
  }
  async clear() {
    this.cols.clear();
  }
}

class FirestoreBackend implements Backend {
  private dbPromise: Promise<any> | null = null;
  private db() {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const { initializeApp, getApps, cert, applicationDefault } = await import('firebase-admin/app');
        const { getFirestore } = await import('firebase-admin/firestore');
        if (!getApps().length) {
          const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
          initializeApp(
            sa
              ? { credential: cert(JSON.parse(sa)) }
              : { credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined },
          );
        }
        return getFirestore();
      })();
    }
    return this.dbPromise;
  }
  async get(c: string, id: string) {
    const snap = await (await this.db()).collection(c).doc(id).get();
    return snap.exists ? snap.data() : null;
  }
  async set(c: string, id: string, data: object) {
    await (await this.db()).collection(c).doc(id).set(data);
  }
  async list(c: string, orderBy: string, limit: number) {
    const snap = await (await this.db()).collection(c).orderBy(orderBy, 'desc').limit(limit).get();
    return snap.docs.map((d: any) => d.data());
  }
  async clear() {
    throw new Error('clear() is only available with STORE=memory');
  }
}

export const storeKind = () => (process.env.STORE === 'memory' ? 'memory' : 'firestore');
const backend: Backend = storeKind() === 'memory' ? new MemoryBackend() : new FirestoreBackend();
const clean = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const docId = (s: string) => s.replace(/[\/#?\s]/g, '_');

// ---------------------------------------------------------------- deliveries

export const getDelivery = async (id: string) => (await backend.get('deliveries', docId(id))) as Delivery | null;
export async function saveDelivery(d: Delivery) {
  d.updatedAt = nowIso();
  await backend.set('deliveries', docId(d.id), clean(d));
}
/** Most recently planned first. Enough for a day's dispatch board. */
export const listDeliveries = (limit = 500) => backend.list('deliveries', 'plannedAt', limit) as Promise<Delivery[]>;

// ------------------------------------------------------------------- threads

const MAX_THREAD = 60;

export const getThread = async (phone: string) => (await backend.get('threads', docId(phone))) as Thread | null;

export async function appendMessage(
  phone: string,
  m: Omit<Message, 'id' | 'at' | 'phone'> & { at?: string },
  meta: { name?: string; party?: Party | 'unknown'; language?: string } = {},
): Promise<Message> {
  const at = m.at || nowIso();
  const thread: Thread = (await getThread(phone)) || { phone, party: meta.party || m.party, messages: [], updatedAt: at };
  const msg: Message = { ...m, id: randomUUID(), phone, at };
  thread.messages = [...thread.messages, msg].slice(-MAX_THREAD);
  thread.updatedAt = at;
  if (m.direction === 'in' && m.channel === 'whatsapp') thread.lastInboundAt = at;
  if (meta.name) thread.name = meta.name;
  if (meta.party && meta.party !== 'unknown') thread.party = meta.party;
  if (meta.language) thread.language = meta.language;
  await backend.set('threads', docId(phone), clean(thread));
  return msg;
}

export async function setThreadLanguage(phone: string, language: string) {
  const t = await getThread(phone);
  if (t && t.language !== language) {
    t.language = language;
    await backend.set('threads', docId(phone), clean(t));
  }
}

export const listThreads = (limit = 100) => backend.list('threads', 'updatedAt', limit) as Promise<Thread[]>;

// -------------------------------------------------------------------- alerts

export async function addAlert(a: Omit<Alert, 'id' | 'at'>): Promise<Alert> {
  const alert: Alert = { ...a, id: randomUUID(), at: nowIso() };
  await backend.set('alerts', alert.id, clean(alert));
  return alert;
}
export async function resolveAlert(id: string) {
  const a = (await backend.get('alerts', id)) as Alert | null;
  if (a) await backend.set('alerts', id, { ...a, resolved: true });
}
export const listAlerts = (limit = 100) => backend.list('alerts', 'at', limit) as Promise<Alert[]>;

// --------------------------------------------------------------------- calls

export const getCall = async (id: string) => (await backend.get('calls', id)) as CallSession | null;
export const saveCall = (c: CallSession) => backend.set('calls', c.id, clean(c));
export const listCalls = (limit = 50) => backend.list('calls', 'startedAt', limit) as Promise<CallSession[]>;

/** Demo only: wipe everything. */
export const clearAll = () => backend.clear();
