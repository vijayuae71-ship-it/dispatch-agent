import { parseLocal, fmtDateTime } from './clock';
import { getDelivery, listDeliveries, saveDelivery } from './store';
import { config, normalizePhone } from './config';
import type { Contact, Delivery, DeliveryStatus } from './types';

// Google Sheets as the order feed: one row per delivery. The dispatcher (or
// their ERP export) fills in the left-hand columns; the bot fills in Status,
// ETA, Location, Last Update, Issue and Site Contact as it learns things.
//
// Set SHEET_ID (from the sheet's URL) and share the sheet with the service
// account's email (Editor). The tab is SHEET_TAB (default "Deliveries").

const SHEET_ID = () => process.env.SHEET_ID || '';
const TAB = () => process.env.SHEET_TAB || 'Deliveries';

export const SHEET_COLUMNS = {
  input: ['Order', 'Material', 'Client', 'Client Phone', 'Client Language', 'Other Contacts', 'Site', 'Site Area', 'Truck', 'Driver', 'Driver Phone', 'Driver Language', 'Planned', 'Notes'],
  output: ['Status', 'ETA', 'Location', 'Last Update', 'Issue', 'Site Contact'],
  required: ['Order', 'Client', 'Client Phone', 'Site', 'Truck', 'Driver', 'Driver Phone', 'Planned'],
};

const STATUSES: DeliveryStatus[] = ['scheduled', 'confirmed', 'en_route', 'delayed', 'arrived', 'delivered', 'rescheduled', 'issue', 'cancelled'];

let tokenClient: any = null;
async function token(): Promise<string> {
  if (!tokenClient) {
    const { GoogleAuth } = await import('google-auth-library');
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    tokenClient = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      ...(sa ? { credentials: JSON.parse(sa) } : {}),
    });
  }
  const t = await tokenClient.getAccessToken();
  return typeof t === 'string' ? t : t?.token;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(json as any)?.error?.message || 'request failed'}`);
  return json;
}

export function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * "Sunil (Site engineer) 98765 43210; Anil +919812345678" → contacts.
 * Separate people with ";" or a new line; a role in brackets is optional.
 */
export function parseContacts(cell: string, toPhone: (s: string) => string): Contact[] {
  return cell
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*?)(\+?[\d][\d\s-]{8,})$/);
      if (!m) return null;
      const role = m[1].match(/\(([^)]+)\)/)?.[1]?.trim();
      const name = m[1].replace(/\([^)]*\)/, '').replace(/[,:-]\s*$/, '').trim() || 'Contact';
      return { name, phone: toPhone(m[2]), ...(role ? { role } : {}) };
    })
    .filter((c): c is Contact => !!c && /^\+\d{8,15}$/.test(c.phone));
}

/** Turn sheet rows into deliveries. Pure: used by sync and by tests. */
export function rowsToDeliveries(rows: string[][]): { header: Record<string, number>; items: { row: number; d: Partial<Delivery> & { id: string }; sheetStatus?: string }[]; errors: string[] } {
  const header: Record<string, number> = {};
  (rows[0] || []).forEach((h, i) => (header[norm(h)] = i));
  const errors: string[] = [];
  const missing = SHEET_COLUMNS.required.filter((c) => header[norm(c)] === undefined);
  if (missing.length) return { header, items: [], errors: [`Missing columns: ${missing.join(', ')}`] };
  const get = (r: string[], c: string) => (header[norm(c)] !== undefined ? String(r[header[norm(c)]] ?? '').trim() : '');
  const phone = (s: string) => normalizePhone(s);
  const items: { row: number; d: Partial<Delivery> & { id: string }; sheetStatus?: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const order = get(r, 'Order');
    if (!order) return;
    const planned = parseLocal(get(r, 'Planned'));
    if (!planned) {
      errors.push(`Row ${i + 2}: can't read Planned "${get(r, 'Planned')}" (use 2026-11-20 14:30 or 20/11/2026 2:30 PM)`);
      return;
    }
    items.push({
      row: i + 2,
      sheetStatus: get(r, 'Status').toLowerCase().replace(/\s+/g, '_'),
      d: {
        id: order,
        orderNo: order,
        material: get(r, 'Material') || 'Material',
        client: { name: get(r, 'Client'), phone: phone(get(r, 'Client Phone')), language: get(r, 'Client Language') || undefined },
        contacts: parseContacts(get(r, 'Other Contacts'), phone),
        site: { name: get(r, 'Site'), area: get(r, 'Site Area') || undefined, contact: get(r, 'Site Contact') || undefined },
        truck: get(r, 'Truck'),
        driver: { name: get(r, 'Driver'), phone: phone(get(r, 'Driver Phone')), language: get(r, 'Driver Language') || undefined },
        plannedAt: planned,
        notes: get(r, 'Notes') || undefined,
      },
    });
  });
  return { header, items, errors };
}

const lastWritten = new Map<string, string>();

/** Pull new/changed rows into the store, then write the bot's view back. */
export async function syncSheet(): Promise<{ imported: number; updated: number; written: number; errors: string[] }> {
  if (!SHEET_ID()) return { imported: 0, updated: 0, written: 0, errors: ['SHEET_ID not set'] };
  const data = await api(`/values/${encodeURIComponent(TAB())}!A1:Z2000`);
  const { header, items, errors } = rowsToDeliveries(data.values || []);
  let imported = 0;
  let updated = 0;
  const writes: { range: string; values: string[][] }[] = [];

  for (const { row, d: incoming, sheetStatus } of items) {
    let d = await getDelivery(incoming.id);
    const snapshot = d ? JSON.stringify({ ...d, updatedAt: '' }) : '';
    if (!d) {
      d = {
        ...(incoming as Delivery),
        status: STATUSES.includes(sheetStatus as DeliveryStatus) ? (sheetStatus as DeliveryStatus) : 'scheduled',
        flags: {},
        source: 'sheet',
        sheetRow: row,
        updatedAt: '',
      };
      imported++;
    } else {
      // Dispatcher edits in the sheet win for the input columns…
      const before = JSON.stringify([d.client, d.driver, d.truck, d.plannedAt, d.material, d.site.name]);
      Object.assign(d, { orderNo: incoming.orderNo, material: incoming.material, truck: incoming.truck, plannedAt: incoming.plannedAt, notes: incoming.notes, contacts: incoming.contacts, sheetRow: row });
      d.client = { ...d.client, ...incoming.client };
      d.driver = { ...d.driver, ...incoming.driver };
      d.site = { ...d.site, name: incoming.site!.name, area: incoming.site!.area, contact: incoming.site!.contact || d.site.contact };
      if (JSON.stringify([d.client, d.driver, d.truck, d.plannedAt, d.material, d.site.name]) !== before) updated++;
      // …and a status typed by a human (different from what we last wrote) overrides the bot.
      const ours = lastWritten.get(d.id);
      if (sheetStatus && STATUSES.includes(sheetStatus as DeliveryStatus) && sheetStatus !== ours && sheetStatus !== d.status) {
        d.status = sheetStatus as DeliveryStatus;
        updated++;
      }
    }
    if (JSON.stringify({ ...d, updatedAt: '' }) !== snapshot) await saveDelivery(d);

    const out: Record<string, string> = {
      Status: d.status,
      ETA: d.eta ? fmtDateTime(d.eta) : '',
      Location: d.lastLocation || '',
      'Last Update': fmtDateTime(d.updatedAt),
      Issue: d.issue || '',
      'Site Contact': d.site.contact || '',
    };
    for (const [col, val] of Object.entries(out)) {
      const c = header[norm(col)];
      if (c === undefined) continue;
      const current = String((data.values[row - 1] || [])[c] ?? '');
      if (current !== val) {
        writes.push({ range: `${TAB()}!${colLetter(c)}${row}`, values: [[val]] });
      }
    }
    lastWritten.set(d.id, d.status);
  }

  if (writes.length) {
    await api('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: writes }) });
  }
  return { imported, updated, written: writes.length, errors };
}

export const sheetConfigured = () => !!SHEET_ID();
export const sheetInfo = () => ({ id: SHEET_ID(), tab: TAB(), timezone: config().timezone });
export { listDeliveries };
