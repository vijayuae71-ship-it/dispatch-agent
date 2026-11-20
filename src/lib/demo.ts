import { clearAll, saveDelivery } from './store';
import { config } from './config';
import { now, setLocalTime } from './clock';
import type { Delivery } from './types';

// A realistic morning for a Pune building-materials transporter, used by the
// console's demo mode. Phone numbers are fictional (+91 90000 0000x).

/** Three dispatch clerks for the demo (only if none are configured). */
export const DEMO_CLERKS = [
  { name: 'Anita', phone: '+919000000901' },
  { name: 'Farhan', phone: '+919000000902' },
  { name: 'Joseph', phone: '+919000000903' },
];

export async function startDemoDay(): Promise<void> {
  await clearAll();
  if (!config().dispatchers.length) config().dispatchers = [...DEMO_CLERKS];
  setLocalTime(9, 0);
  const at = (h: number, m = 0) => {
    const t = now();
    return new Date(t.getTime() + ((h - 9) * 60 + m) * 60_000).toISOString();
  };
  const base = { flags: {}, source: 'demo' as const, updatedAt: '' };
  const deliveries: Delivery[] = [
    {
      ...base,
      id: 'ORD-1045',
      orderNo: 'ORD-1045',
      material: '30 t M-sand',
      client: { name: 'Deshmukh & Sons', phone: '+919000000105', language: 'mr-IN' },
      contacts: [{ name: 'Vikas', role: 'Site supervisor', phone: '+919000000115', language: 'hi-IN' }],
      site: { name: 'Hadapsar Greens', area: 'Hadapsar, Pune', contact: 'Vikas 98xxxxxx10' },
      truck: 'MH-12-RT-6604',
      driver: { name: 'Gurpreet Singh', phone: '+919000000205', language: 'pa-IN' },
      plannedAt: at(9, 45),
      eta: at(9, 45),
      status: 'en_route',
      clientConfirmedAt: at(8, 0),
      flags: { clientAskedAt: at(7, 45) },
    },
    {
      ...base,
      id: 'ORD-1042',
      orderNo: 'ORD-1042',
      material: '25 t TMT steel bars',
      client: { name: 'Shah Builders', phone: '+919000000102', language: 'en-IN' },
      site: { name: 'Baner Heights', area: 'Baner, Pune' },
      truck: 'MH-14-GH-2093',
      driver: { name: 'Suresh Patil', phone: '+919000000202', language: 'mr-IN' },
      plannedAt: at(10, 30),
      eta: at(10, 30),
      status: 'en_route',
      clientConfirmedAt: at(8, 30),
      flags: { clientAskedAt: at(8, 15) },
    },
    {
      ...base,
      id: 'ORD-1041',
      orderNo: 'ORD-1041',
      material: '600 bags OPC 53 cement',
      client: { name: 'Patil Constructions', phone: '+919000000101', language: 'hi-IN' },
      contacts: [
        { name: 'Sunil', role: 'Site engineer', phone: '+919000000111', language: 'hi-IN' },
        { name: 'Meera', role: 'Purchase manager', phone: '+919000000121', language: 'en-IN' },
      ],
      site: { name: 'Wakad Residency', area: 'Wakad, Pune' },
      truck: 'MH-12-PQ-4821',
      driver: { name: 'Ramesh Yadav', phone: '+919000000201', language: 'hi-IN' },
      plannedAt: at(11, 0),
      status: 'scheduled',
    },
    {
      ...base,
      id: 'ORD-1043',
      orderNo: 'ORD-1043',
      material: '20 t fly-ash bricks',
      client: { name: 'Kumar Infra', phone: '+919000000103', language: 'en-IN' },
      site: { name: 'Hinjewadi Phase 2 tower B', area: 'Hinjewadi, Pune' },
      truck: 'MH-12-KL-7715',
      driver: { name: 'Abdul Rahman', phone: '+919000000203', language: 'hi-IN' },
      plannedAt: at(12, 30),
      status: 'scheduled',
    },
    {
      ...base,
      id: 'ORD-1044',
      orderNo: 'ORD-1044',
      material: '400 bags PPC cement',
      client: { name: 'Lakshmi Developers', phone: '+919000000104', language: 'ta-IN' },
      site: { name: 'Kharadi IT Park annex', area: 'Kharadi, Pune' },
      truck: 'MH-12-TT-3390',
      driver: { name: 'Manjunath Gowda', phone: '+919000000204', language: 'kn-IN' },
      plannedAt: at(14, 0),
      status: 'scheduled',
    },
  ];
  for (const d of deliveries) await saveDelivery(d);
}
