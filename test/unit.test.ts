import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/lib/config';
import { decide } from '../src/lib/rules';
import { parseLocal, fmtTime } from '../src/lib/clock';
import { rowsToDeliveries, colLetter } from '../src/lib/sheets';
import { renderTemplate, templateVars } from '../src/lib/templates';
import { OutputSplitter } from '../src/lib/agent';
import type { Delivery } from '../src/lib/types';

const cfg = loadConfig('config/dispatch.json');
const T0 = new Date('2026-11-20T03:30:00Z'); // 9:00 AM IST
const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
const base = (o: Partial<Delivery>): Delivery =>
  ({
    id: 'D1', orderNo: 'D1', material: 'cement', truck: 'MH-12-AB-1234', status: 'scheduled', flags: {}, updatedAt: '',
    client: { name: 'C', phone: '+919000000001' }, driver: { name: 'Dr', phone: '+919000000002' }, site: { name: 'Site' },
    plannedAt: at(120), ...o,
  }) as Delivery;

test('asks the client to confirm 2 hours before, once', () => {
  assert.deepEqual(decide([base({})], T0, cfg).map((a) => a.kind), ['ask_client_confirm']);
  assert.deepEqual(decide([base({ plannedAt: at(121) })], T0, cfg), []);
  assert.deepEqual(decide([base({ flags: { clientAskedAt: at(-5) } })], T0, cfg), []);
});

test('no client reply → call, then alert after the call', () => {
  const asked = base({ flags: { clientAskedAt: at(-20) } });
  assert.deepEqual(decide([asked], T0, cfg).map((a) => a.kind), ['call']);
  const called = base({ flags: { clientAskedAt: at(-45), clientCalledAt: at(-20) } });
  const a = decide([called], T0, cfg);
  assert.equal(a[0].kind, 'alert');
  assert.equal(decide([base({ flags: { clientAskedAt: at(-20) } })], T0, { ...cfg, callsEnabled: false })[0].kind, 'alert');
});

test('checks on the driver only when the ETA is due or missed', () => {
  const onWay = base({ status: 'en_route', plannedAt: at(60), eta: at(60) });
  assert.deepEqual(decide([onWay], T0, cfg), []);
  assert.equal((decide([{ ...onWay, eta: at(10) }], T0, cfg)[0] as any).reason, 'eta_due');
  assert.equal((decide([{ ...onWay, eta: at(-5), plannedAt: at(-5) }], T0, cfg)[0] as any).reason, 'eta_passed');
  // Fresh driver update after the ETA: leave them alone.
  assert.deepEqual(decide([{ ...onWay, eta: at(-5), plannedAt: at(-5), lastDriverUpdateAt: at(-1) }], T0, cfg), []);
});

test('unreachable driver → call, then a critical alert', () => {
  const d = base({ status: 'en_route', plannedAt: at(-10), eta: at(-10), flags: { driverAskedAt: at(-25) } });
  assert.deepEqual(decide([d], T0, cfg).map((a) => a.kind), ['call']);
  const after = decide([{ ...d, flags: { driverAskedAt: at(-50), driverCalledAt: at(-25) } }], T0, cfg);
  assert.equal(after[0].kind, 'alert');
  assert.equal((after[0] as any).severity, 'critical');
});

test('late trucks raise one alert; closed deliveries are ignored', () => {
  const late = base({ status: 'delayed', plannedAt: at(30), eta: at(90), lastDriverUpdateAt: at(-1) });
  assert.deepEqual(decide([late], T0, cfg).map((a) => a.kind), ['alert']);
  assert.deepEqual(decide([{ ...late, flags: { lateAlertedAt: at(-1) } }], T0, cfg), []);
  assert.deepEqual(decide([base({ status: 'delivered' })], T0, cfg), []);
});

test('parses sheet date formats in Indian time', () => {
  assert.equal(parseLocal('2026-11-20 14:30'), '2026-11-20T09:00:00.000Z');
  assert.equal(parseLocal('20/11/2026 2:30 PM'), '2026-11-20T09:00:00.000Z');
  assert.equal(parseLocal('20-11-2026 12:15 am'), '2026-11-19T18:45:00.000Z');
  assert.equal(parseLocal('not a date'), null);
  assert.equal(fmtTime('2026-11-20T09:00:00Z'), '2:30 PM');
});

test('reads deliveries from sheet rows', () => {
  const rows = [
    ['Order', 'Material', 'Client', 'Client Phone', 'Site', 'Truck', 'Driver', 'Driver Phone', 'Planned', 'Status'],
    ['ORD-1', 'OPC 53, 600 bags', 'Patil', '98765 43210', 'Wakad', 'MH-12-PQ-4821', 'Ramesh', '+919812345678', '2026-11-20 11:00', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['ORD-2', 'Steel', 'Shah', '9876543211', 'Baner', 'MH-14', 'Suresh', '9812345679', 'tomorrow', ''],
  ];
  const r = rowsToDeliveries(rows);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].d.client!.phone, '+919876543210');
  assert.equal(r.items[0].row, 2);
  assert.match(r.errors[0], /Row 4/);
  assert.match(rowsToDeliveries([['Order', 'Client']]).errors[0], /Missing columns/);
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(27), 'AB');
});

test('templates fill in delivery details in English and Hinglish', () => {
  const d = base({ plannedAt: '2026-11-20T05:30:00Z' });
  const en = renderTemplate('client_confirm', 'en-IN', templateVars('client_confirm', d));
  assert.match(en.text, /order D1 \(cement\) is planned to reach Site around 11:00 AM on truck MH-12-AB-1234/);
  assert.equal(en.envKey, 'TEMPLATE_CLIENT_CONFIRM_EN');
  assert.match(renderTemplate('driver_eta', 'hi-IN', templateVars('driver_eta', d)).text, /^Namaste Dr, Demo Logistics dispatch se/);
});

test('voice splitter hides the language tag and metadata', () => {
  let out = '';
  let tag = '';
  const s = new OutputSplitter((x) => (out += x), (c) => (tag = c));
  ['[[hi', '-IN]] नमस्ते', ' जी <', '<<{"action":"end"}>>>'].forEach((c) => s.push(c));
  s.end();
  assert.equal(tag, 'hi-IN');
  assert.equal(out, 'नमस्ते जी ');
  assert.match(s.meta, /"action":"end"/);
});

test('clerk commands are understood in English and Hinglish', async () => {
  const { parseClerkCommand } = await import('../src/lib/clerks');
  assert.deepEqual(parseClerkCommand('take 12'), { kind: 'take', n: 12 });
  assert.deepEqual(parseClerkCommand('Take #12'), { kind: 'take', n: 12 });
  assert.deepEqual(parseClerkCommand('12 mine'), { kind: 'take', n: 12 });
  assert.deepEqual(parseClerkCommand('le 7'), { kind: 'take', n: 7 });
  assert.deepEqual(parseClerkCommand('done 12'), { kind: 'done', n: 12 });
  assert.deepEqual(parseClerkCommand('12 ho gaya'), { kind: 'done', n: 12 });
  assert.deepEqual(parseClerkCommand('list'), { kind: 'list' });
  assert.deepEqual(parseClerkCommand('what is happening?'), { kind: 'help' });
});

test('sheet "Other Contacts" cell becomes contacts with roles', async () => {
  const { parseContacts } = await import('../src/lib/sheets');
  const toPhone = (s: string) => { const p = s.replace(/[\s-]/g, ''); return /^\d{10}$/.test(p) ? `+91${p}` : p; };
  assert.deepEqual(parseContacts('Sunil (Site engineer) 98765 43210; Meera +919812345678', toPhone), [
    { name: 'Sunil', phone: '+919876543210', role: 'Site engineer' },
    { name: 'Meera', phone: '+919812345678' },
  ]);
  assert.deepEqual(parseContacts('', toPhone), []);
  assert.deepEqual(parseContacts('just a name', toPhone), []);
});

test('assign command parsing', async () => {
  const { parseAssign } = await import('../src/lib/assign');
  assert.deepEqual(parseAssign('assign 101 mh12ab1234 98765 43210 Ramesh Yadav'), { ref: '101', truck: 'MH12AB1234', driverPhone: '9876543210', driverName: 'Ramesh Yadav' });
  assert.deepEqual(parseAssign('a #102 23758FUJ +971526063475'), { ref: '102', truck: '23758FUJ', driverPhone: '+971526063475', driverName: undefined });
  assert.equal(parseAssign('take 12'), null);
  assert.equal(parseAssign('assign 101 MH12'), null);
});

test('phone numbers are normalised with the company country code', async () => {
  const { normalizePhone, config } = await import('../src/lib/config');
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('+971 52 606 3475'), '+971526063475');
  assert.equal(normalizePhone('00971526063475'), '+971526063475');
  config().defaultCountryCode = '+971';
  assert.equal(normalizePhone('0526063475'), '+971526063475');
  config().defaultCountryCode = '+91';
});
