import type { DispatchConfig } from './config';
import { CLOSED, type Delivery } from './types';
import { fmtTime, minutesBetween } from './clock';

// The dispatch rules: given the deliveries and the time, decide what to do.
// Pure function, no side effects, so it's easy to test and to reason about.

export type Action =
  | { kind: 'ask_client_confirm'; deliveryId: string }
  | { kind: 'ask_driver_eta'; deliveryId: string; reason: 'eta_due' | 'eta_passed' | 'stale' }
  | { kind: 'call'; party: 'client' | 'driver'; deliveryId: string; reason: string }
  | { kind: 'alert'; deliveryId: string; severity: 'info' | 'warning' | 'critical'; text: string; flag: keyof Delivery['flags'] };

const ON_THE_ROAD = ['confirmed', 'en_route', 'delayed'];

export function decide(deliveries: Delivery[], now: Date, cfg: DispatchConfig): Action[] {
  const r = cfg.rules;
  const out: Action[] = [];

  for (const d of deliveries) {
    if (CLOSED.includes(d.status) || d.status === 'issue' || d.status === 'rescheduled') continue;
    // Ordered but no truck yet: nothing to ask anyone; nudge the clerks an hour before it's due.
    if (d.status === 'requested') {
      if (!d.flags?.unassignedAlertedAt && minutesBetween(now, d.plannedAt) <= 60) {
        out.push({
          kind: 'alert',
          deliveryId: d.id,
          severity: 'warning',
          text: `Order #${d.number ?? d.orderNo} for ${d.client.name} (${d.material} to ${d.site.name}, due ${fmtTime(d.plannedAt)}) still has no truck.`,
          flag: 'unassignedAlertedAt',
        });
      }
      continue;
    }
    const f = d.flags || {};
    const minsToPlanned = minutesBetween(now, d.plannedAt);
    const eta = d.eta || d.plannedAt;
    const minsToEta = minutesBetween(now, eta);

    // 1. Client confirmation before delivery.
    if (d.status === 'scheduled' && !f.clientAskedAt && minsToPlanned <= r.clientConfirmLeadMin && minsToPlanned > -30) {
      out.push({ kind: 'ask_client_confirm', deliveryId: d.id });
    }

    // 2. Client didn't reply → call, or tell the dispatcher.
    if (d.status === 'scheduled' && f.clientAskedAt && !d.clientConfirmedAt && minutesBetween(f.clientAskedAt, now) >= r.noReplyMin) {
      if (cfg.callsEnabled && !f.clientCalledAt) {
        out.push({ kind: 'call', party: 'client', deliveryId: d.id, reason: 'No WhatsApp reply to the delivery confirmation' });
      } else if (!f.noReplyAlertedClientAt && (!cfg.callsEnabled || minutesBetween(f.clientCalledAt!, now) >= r.noReplyMin)) {
        out.push({
          kind: 'alert',
          deliveryId: d.id,
          severity: 'warning',
          text: `${d.client.name} hasn't confirmed order ${d.orderNo}${cfg.callsEnabled ? ' (no reply on WhatsApp or the call)' : ''}. Readiness to receive unknown.`,
          flag: 'noReplyAlertedClientAt',
        });
      }
    }

    // 3. Driver ETA check: only when it matters.
    if (ON_THE_ROAD.includes(d.status)) {
      const askedRecently = f.driverAskedAt && minutesBetween(f.driverAskedAt, now) < r.driverStaleMin;
      const updatedRecently = d.lastDriverUpdateAt && minutesBetween(d.lastDriverUpdateAt, now) < r.driverStaleMin;
      const updatedSinceEta = d.lastDriverUpdateAt && minutesBetween(eta, d.lastDriverUpdateAt) >= 0;
      let reason: 'eta_due' | 'eta_passed' | 'stale' | null = null;
      if (minsToEta < 0 && !updatedSinceEta) reason = 'eta_passed';
      else if (minsToEta <= r.driverCheckBeforeEtaMin && !d.lastDriverUpdateAt) reason = 'eta_due';
      else if (d.lastDriverUpdateAt && !updatedRecently && minsToEta < 60) reason = 'stale';
      if (reason && !askedRecently) out.push({ kind: 'ask_driver_eta', deliveryId: d.id, reason });

      // 4. Driver didn't answer → call, or tell the dispatcher.
      const unanswered = f.driverAskedAt && (!d.lastDriverUpdateAt || d.lastDriverUpdateAt < f.driverAskedAt);
      if (unanswered && minutesBetween(f.driverAskedAt!, now) >= r.noReplyMin) {
        if (cfg.callsEnabled && (!f.driverCalledAt || f.driverCalledAt < f.driverAskedAt!)) {
          out.push({ kind: 'call', party: 'driver', deliveryId: d.id, reason: 'No WhatsApp reply to the ETA check' });
        } else if (!f.noReplyAlertedDriverAt && (!cfg.callsEnabled || minutesBetween(f.driverCalledAt!, now) >= r.noReplyMin)) {
          out.push({
            kind: 'alert',
            deliveryId: d.id,
            severity: 'critical',
            text: `Driver ${d.driver.name} (truck ${d.truck}) not reachable for order ${d.orderNo}. Last known: ${d.lastLocation || 'no update'}.`,
            flag: 'noReplyAlertedDriverAt',
          });
        }
      }

      // 5. Running late → tell the dispatcher once.
      if (d.eta && minutesBetween(d.plannedAt, d.eta) >= r.lateThresholdMin && !f.lateAlertedAt) {
        out.push({
          kind: 'alert',
          deliveryId: d.id,
          severity: 'warning',
          text: `Order ${d.orderNo} to ${d.site.name} running ${Math.round(minutesBetween(d.plannedAt, d.eta))} min late (truck ${d.truck}${d.lastLocation ? `, at ${d.lastLocation}` : ''}).`,
          flag: 'lateAlertedAt',
        });
      }
    }
  }
  return out;
}
