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

export const SCENARIOS = {
  construction: { label: 'Building materials · Pune', description: 'building materials (cement, steel, M-sand, bricks) by truck to construction sites' },
  fmcg: { label: 'FMCG distribution · Mumbai', description: 'FMCG goods (biscuits, edible oil, soft drinks, detergent, noodles) in cartons and crates to retail stores, hotels and distributors' },
} as const;
export type Scenario = keyof typeof SCENARIOS;

const stamp = () => {
  const t = now();
  return (h: number, m = 0) => new Date(t.getTime() + ((h - 9) * 60 + m) * 60_000).toISOString();
};
const base = { flags: {}, source: 'demo' as const, updatedAt: '' };

export async function startDemoDay(scenario: Scenario = 'construction'): Promise<void> {
  await clearAll();
  if (!config().dispatchers.length) config().dispatchers = [...DEMO_CLERKS];
  config().businessDescription = SCENARIOS[scenario].description;
  // The demo day shows its own industry's wording, whatever the company picked in setup.
  config().industry = scenario;
  setLocalTime(9, 0);
  const deliveries = scenario === 'fmcg' ? fmcgDay() : constructionDay();
  for (const d of deliveries) await saveDelivery(d);
}

function constructionDay(): Delivery[] {
  const at = stamp();
  return [
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
}

/** A morning at a Mumbai FMCG distributor: small trucks, many stores. */
function fmcgDay(): Delivery[] {
  const at = stamp();
  return [
    {
      ...base,
      id: 'F-201',
      orderNo: 'F-201',
      material: '120 cartons biscuits',
      client: { name: 'Sharma General Store', phone: '+919000000301', language: 'hi-IN' },
      contacts: [{ name: 'Rakesh', role: 'Store manager', phone: '+919000000311', language: 'hi-IN' }],
      site: { name: 'Sharma General Store', area: 'Andheri West, Mumbai' },
      truck: 'MH-02-ER-1180',
      driver: { name: 'Santosh Jadhav', phone: '+919000000401', language: 'mr-IN' },
      plannedAt: at(9, 40),
      eta: at(9, 40),
      status: 'en_route',
      clientConfirmedAt: at(8, 0),
      flags: { clientAskedAt: at(7, 40) },
    },
    {
      ...base,
      id: 'F-202',
      orderNo: 'F-202',
      material: '80 cartons edible oil',
      client: { name: 'Patel Kirana Mart', phone: '+919000000302', language: 'gu-IN' },
      site: { name: 'Patel Kirana Mart', area: 'Thane West' },
      truck: 'MH-04-KL-2271',
      driver: { name: 'Imran Shaikh', phone: '+919000000402', language: 'hi-IN' },
      plannedAt: at(10, 15),
      eta: at(10, 15),
      status: 'en_route',
      clientConfirmedAt: at(8, 20),
      flags: { clientAskedAt: at(8, 15) },
    },
    {
      ...base,
      id: 'F-203',
      orderNo: 'F-203',
      material: '150 crates soft drinks',
      client: { name: 'Hotel Sea Breeze', phone: '+919000000303', language: 'en-IN' },
      site: { name: 'Hotel Sea Breeze (goods entrance)', area: 'Juhu, Mumbai' },
      truck: 'MH-02-BQ-5530',
      driver: { name: 'Dinesh Yadav', phone: '+919000000403', language: 'hi-IN' },
      plannedAt: at(11, 0),
      status: 'scheduled',
    },
    {
      ...base,
      id: 'F-204',
      orderNo: 'F-204',
      material: '60 cartons detergent',
      client: { name: 'Om Sai Distributors', phone: '+919000000304', language: 'hi-IN' },
      site: { name: 'Om Sai warehouse', area: 'Bhiwandi' },
      truck: 'MH-04-TT-8812',
      driver: { name: 'Mahesh Patil', phone: '+919000000404', language: 'mr-IN' },
      plannedAt: at(12, 30),
      status: 'scheduled',
    },
    {
      ...base,
      id: 'F-205',
      orderNo: 'F-205',
      material: '200 cartons instant noodles',
      client: { name: 'Powai Fresh Supermarket', phone: '+919000000305', language: 'en-IN' },
      contacts: [{ name: 'Anjali', role: 'Receiving desk', phone: '+919000000315', language: 'en-IN' }],
      site: { name: 'Powai Fresh Supermarket', area: 'Powai, Mumbai' },
      truck: 'MH-03-AZ-4407',
      driver: { name: 'Ravi Kumar', phone: '+919000000405', language: 'hi-IN' },
      plannedAt: at(14, 0),
      status: 'scheduled',
    },
  ];
}
