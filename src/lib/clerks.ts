import { config } from './config';
import { fmtTime } from './clock';
import { sendTemplate, sendText } from './outbox';
import { templateVars } from './templates';
import { findAlertByNumber, getAlert, listAlerts, resolveAlert, saveAlert } from './store';
import { nowIso } from './clock';
import type { Alert } from './types';
import { assignTruck, parseAssign } from './assign';

// The dispatch clerks' side. Every alert goes to every clerk on WhatsApp with
// a number; a clerk replies "take 12" to own it (the others are told, so no
// one doubles up), "done 12" to close it, and "list" to see what's open.
// Commands are matched by simple rules, not AI: fast, free and predictable.

const ICON = { critical: '🔴', warning: '🟠', info: '🔵' } as const;

export type ClerkCommand = { kind: 'take' | 'done'; n: number } | { kind: 'list' } | { kind: 'help' };

/** "take 12", "t12", "le 12", "12 mine" · "done 12", "ho gaya 12", "close #12" · "list", "alerts". */
export function parseClerkCommand(text: string): ClerkCommand {
  const s = text.trim().toLowerCase().replace(/[#.!]/g, ' ').replace(/\s+/g, ' ');
  if (/^(list|alerts?|open|pending|ls)$/.test(s)) return { kind: 'list' };
  const take = s.match(/^(?:take|t|le|lo|mine|mera|main)\s*(\d+)$/) || s.match(/^(\d+)\s*(?:take|mine|mera|le|lo|main)$/);
  if (take) return { kind: 'take', n: Number(take[1]) };
  const done = s.match(/^(?:done|d|close|closed|resolve|resolved|ok|ho gaya|hogaya|ho gya)\s*(\d+)$/) || s.match(/^(\d+)\s*(?:done|closed|resolved|ok|ho gaya|hogaya|ho gya)$/);
  if (done) return { kind: 'done', n: Number(done[1]) };
  return { kind: 'help' };
}

const clerks = () => config().dispatchers;

/** One line (WhatsApp template variables can't contain line breaks). */
export function alertLine(a: Alert): string {
  return `${ICON[a.severity]} #${a.number}: ${a.text} Reply "take ${a.number}" to handle it.`;
}

/** Send a new alert to every clerk. */
export async function notifyClerks(a: Alert) {
  for (const c of clerks()) {
    await sendTemplate(c.phone, 'dispatcher_alert', templateVars('dispatcher_alert', null, alertLine(a)), { party: 'dispatcher', name: c.name, language: 'en' });
  }
}

/** Tell every clerk except `exceptName` (who already knows). */
async function broadcast(text: string, exceptName?: string) {
  for (const c of clerks()) {
    if (c.name === exceptName) continue;
    await sendText(c.phone, text, { party: 'dispatcher', name: c.name });
  }
}

export async function assignAlert(id: string, clerk: string): Promise<{ ok: boolean; message: string; alert?: Alert }> {
  const a = await getAlert(id);
  if (!a) return { ok: false, message: 'Alert not found.' };
  if (a.resolved) return { ok: false, message: `#${a.number} is already closed${a.resolvedBy ? ` by ${a.resolvedBy}` : ''}.`, alert: a };
  if (a.assignedTo && a.assignedTo !== clerk) return { ok: false, message: `#${a.number} is already with ${a.assignedTo}.`, alert: a };
  a.assignedTo = clerk;
  a.assignedAt = nowIso();
  await saveAlert(a);
  await broadcast(`✋ ${clerk} took #${a.number}: ${a.text}`, clerk);
  return { ok: true, message: `✋ #${a.number} is yours. Reply "done ${a.number}" when it's sorted.`, alert: a };
}

export async function closeAlert(id: string, clerk: string): Promise<{ ok: boolean; message: string }> {
  const a = await getAlert(id);
  if (!a) return { ok: false, message: 'Alert not found.' };
  if (a.resolved) return { ok: false, message: `#${a.number} is already closed${a.resolvedBy ? ` by ${a.resolvedBy}` : ''}.` };
  await resolveAlert(id, clerk);
  await broadcast(`✅ ${clerk} closed #${a.number}.`, clerk);
  return { ok: true, message: `✅ Closed #${a.number}.` };
}

export async function openAlertsText(): Promise<string> {
  const open = (await listAlerts(200)).filter((a) => !a.resolved).sort((x, y) => x.number - y.number);
  if (!open.length) return '✅ No open alerts.';
  return [
    `Open alerts (${open.length}):`,
    ...open.map((a) => `${ICON[a.severity]} #${a.number} ${fmtTime(a.at)} · ${a.assignedTo ? `✋ ${a.assignedTo}` : 'unassigned'} · ${a.text}`),
  ].join('\n');
}

const HELP = 'Commands: "take 12" to handle alert #12 · "done 12" when it\'s sorted · "list" for open alerts · "assign 101 TRUCK DRIVER-PHONE NAME" to put a truck on order 101.';

/** A clerk wrote to the bot on WhatsApp. Returns the reply sent. */
export async function handleClerkMessage(phone: string, name: string, text: string): Promise<string> {
  const assign = parseAssign(text);
  const cmd = parseClerkCommand(text);
  let reply: string;
  if (assign) reply = (await assignTruck({ ...assign, by: name })).message;
  else if (cmd.kind === 'list') reply = await openAlertsText();
  else if (cmd.kind === 'help') reply = HELP;
  else {
    const a = await findAlertByNumber(cmd.n);
    if (!a) reply = `There's no alert #${cmd.n}. ${HELP}`;
    else reply = (cmd.kind === 'take' ? await assignAlert(a.id, name) : await closeAlert(a.id, name)).message;
  }
  await sendText(phone, reply, { party: 'dispatcher', name });
  return reply;
}
