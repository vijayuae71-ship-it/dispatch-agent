import { config } from './config';

// A clock that demo mode can move forward ("advance 30 minutes") so a whole
// dispatch day can be shown in a few minutes. In production the offset stays 0.

let offsetMs = 0;

export const now = () => new Date(Date.now() + offsetMs);
export const nowIso = () => now().toISOString();
export const clockOffsetMs = () => offsetMs;

export function advanceClock(minutes: number) {
  offsetMs += minutes * 60_000;
}

/** Set the clock so that local time (in the company time zone) is hh:mm today. */
export function setLocalTime(hh: number, mm = 0) {
  const real = new Date();
  const parts = localParts(real);
  const targetMs = (hh * 60 + mm) * 60_000;
  const currentMs = (parts.hour * 60 + parts.minute) * 60_000 + parts.second * 1000;
  offsetMs = targetMs - currentMs;
}

export function resetClock() {
  offsetMs = 0;
}

export const minutesBetween = (a: Date | string, b: Date | string) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

function localParts(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: config().timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour') % 24, minute: g('minute'), second: g('second') };
}

/** "2:30 PM" in the company time zone. */
export function fmtTime(iso?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: config().timezone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso))
    .replace(/\s?(am|pm)$/i, (m) => ' ' + m.trim().toUpperCase());
}

/** "Thu 20 Nov, 2:30 PM" in the company time zone. */
export function fmtDateTime(iso?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: config().timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** UTC offset of the company time zone at a given moment, e.g. "+05:30". */
export function tzOffset(at = now()): string {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: config().timezone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((x) => x.type === 'timeZoneName')?.value;
  const m = s?.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+00:00';
}

/**
 * Parse a local date-time as typed in a sheet: "2026-11-20 14:30",
 * "20/11/2026 14:30", "20-11-2026 2:30 PM", or a bare time "14:30" (today).
 */
export function parseLocal(text: string, at = now()): string | null {
  const s = text.trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s) && !isNaN(Date.parse(s))) return new Date(s).toISOString();
  let y: number, mo: number, d: number;
  let rest: string;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]?(.*)$/);
  if (m) [y, mo, d, rest] = [+m[1], +m[2], +m[3], m[4]];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ T]?(.*)$/))) [d, mo, y, rest] = [+m[1], +m[2], +m[3], m[4]];
  else {
    const p = localParts(at);
    [y, mo, d, rest] = [p.year, p.month, p.day, s];
  }
  const t = rest.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!t && rest.trim()) return null;
  let hh = t ? +t[1] : 0;
  const mi = t && t[2] ? +t[2] : 0;
  const ap = t?.[3]?.toLowerCase();
  if (ap?.startsWith('p') && hh < 12) hh += 12;
  if (ap?.startsWith('a') && hh === 12) hh = 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const guess = new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mi)}:00Z`);
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mi)}:00${tzOffset(guess)}`;
  const out = new Date(iso);
  return isNaN(out.getTime()) ? null : out.toISOString();
}
