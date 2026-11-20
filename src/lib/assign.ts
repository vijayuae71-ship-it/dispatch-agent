import { config, normalizePhone } from './config';
import { nowIso } from './clock';
import { clientContacts } from './engine';
import { sendTemplate, sendText } from './outbox';
import { statusPhrase, templateVars } from './templates';
import { findDelivery, listAlerts, saveAlert, saveDelivery } from './store';
import type { Delivery } from './types';

// Putting a truck and driver on an order: from a clerk's WhatsApp
// ("assign 101 MH12AB1234 9876543210 Ramesh") or the console. The driver gets
// the trip on WhatsApp, every customer contact is told, and the order's
// "needs truck" alert closes itself.

export interface AssignInput {
  ref: string;
  truck: string;
  driverPhone: string;
  driverName?: string;
  by: string;
}

/** "assign 101 MH12AB1234 98765 43210 Ramesh Yadav" → parts. Null if it isn't an assign command. */
export function parseAssign(text: string): Omit<AssignInput, 'by'> | null {
  const m = text.trim().match(/^(?:assign|a)\s+#?(\S+)\s+(\S+)\s+(\+?[\d][\d\s-]{7,}\d)\s*(.*)$/i);
  if (!m) return null;
  return { ref: m[1], truck: m[2].toUpperCase(), driverPhone: m[3].replace(/[\s-]/g, ''), driverName: m[4].trim() || undefined };
}

export async function assignTruck(input: AssignInput): Promise<{ ok: boolean; message: string; delivery?: Delivery }> {
  const d = await findDelivery(input.ref);
  if (!d) return { ok: false, message: `There's no order ${input.ref}.` };
  if (['delivered', 'cancelled'].includes(d.status)) return { ok: false, message: `Order ${input.ref} is already ${d.status}.` };
  const phone = normalizePhone(input.driverPhone);
  if (!/^\+\d{8,15}$/.test(phone)) return { ok: false, message: `"${input.driverPhone}" doesn't look like a phone number.` };

  d.truck = input.truck.toUpperCase();
  d.driver = { name: input.driverName || d.driver.name || 'Driver', phone, language: d.driver.language };
  if (d.status === 'requested') d.status = 'scheduled';
  await saveDelivery(d);

  // Close the "needs truck" alert(s) for this order.
  for (const a of (await listAlerts(500)).filter((x) => x.deliveryId === d.id && x.kind === 'needs_truck' && !x.resolved)) {
    await saveAlert({ ...a, resolved: true, resolvedBy: input.by, resolvedAt: nowIso(), assignedTo: a.assignedTo || input.by });
  }

  // Driver: the trip. Customer side: truck and driver details.
  await sendTemplate(d.driver.phone, 'driver_trip', templateVars('driver_trip', d), { party: 'driver', name: d.driver.name, deliveryIds: [d.id] });
  for (const c of clientContacts(d)) {
    await sendTemplate(c.phone, 'client_update', templateVars('client_update', d, statusPhrase('assigned', d, c.language)), {
      party: 'client',
      name: c === d.client ? c.name : `${c.name}${c.role ? ` (${c.role})` : ''}, ${d.client.name}`,
      language: c.language,
      deliveryIds: [d.id],
    });
  }
  // Other clerks: who did it.
  for (const clerk of config().dispatchers) {
    if (clerk.name !== input.by) await sendText(clerk.phone, `🚚 ${input.by} assigned ${d.truck} (${d.driver.name}) to order ${d.number ?? d.orderNo}.`, { party: 'dispatcher', name: clerk.name });
  }
  return { ok: true, message: `🚚 Order ${d.number ?? d.orderNo}: ${d.truck} with ${d.driver.name} (${d.driver.phone}). Driver and customer informed.`, delivery: d };
}
