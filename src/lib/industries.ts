import type { VoiceLanguage } from './config';

// One-time onboarding picks an industry and a region. The industry tailors
// what the bot asks and how it talks; the region sets the phone country
// code, time zone and languages.

export type IndustryId = 'construction' | 'fmcg' | 'cold_chain' | 'ecommerce' | 'tankers' | 'general';

export interface IndustryProfile {
  id: IndustryId;
  label: string;
  /** Pre-fills the business description during setup. */
  description: string;
  /** What the customer is asked to confirm before delivery (end of the client_confirm template). */
  confirmAsk: { en: string; hi: string };
  /** What the driver is asked during a check-in (middle of the driver_eta template). */
  driverAsk: { en: string; hi: string };
  /** Industry rules the AI follows: vocabulary, what's urgent, what to capture. */
  aiNotes: string;
  /** Demo day that fits this industry, if there is one. */
  demo?: 'construction' | 'fmcg';
}

export const INDUSTRIES: Record<IndustryId, IndustryProfile> = {
  construction: {
    id: 'construction',
    label: 'Construction materials',
    description: 'building materials (cement, steel, sand, aggregates, bricks, ready-mix) by truck to construction sites and plants',
    confirmAsk: {
      en: 'Please reply to confirm the site is ready to unload (access, labour or equipment), and share the site contact if it has changed.',
      hi: 'Kripya confirm karein ki site par unloading ki taiyari hai (raasta, labour ya machine), aur site contact badla ho to bata dein.',
    },
    driverAsk: { en: 'where are you now and what time will you reach the site?', hi: 'abhi aap kahan ho aur site par kitne baje pahunchoge?' },
    aiNotes:
      'Locations are sites and plants; customers talk about trips, bulkers, tippers, bags and tonnes. Critical: site refuses entry, no access road, breakdown, accident. Ready-mix and cement have time limits after loading, so delays matter: flag a delay over 60 minutes as a warning.',
    demo: 'construction',
  },
  fmcg: {
    id: 'fmcg',
    label: 'FMCG & retail distribution',
    description: 'FMCG goods in cartons and crates to retail stores, supermarkets, hotels and distributors',
    confirmAsk: {
      en: 'Please reply to confirm someone will be at the store to receive and count the goods, and share the receiving contact if it has changed.',
      hi: 'Kripya confirm karein ki store par maal receive aur count karne ke liye koi hoga, aur receiving contact badla ho to bata dein.',
    },
    driverAsk: { en: 'where are you now and what time will you reach the store?', hi: 'abhi aap kahan ho aur store par kitne baje pahunchoge?' },
    aiNotes:
      'Locations are stores, outlets, warehouses and distributors; goods are cartons, cases and crates. Capture shortages, damaged or wrong items at delivery as an issue (warning). Store receiving windows matter: if the store says it closes or stops receiving at a time, note it.',
    demo: 'fmcg',
  },
  cold_chain: {
    id: 'cold_chain',
    label: 'Cold chain (food & pharma)',
    description: 'temperature-controlled food and pharmaceuticals by reefer truck to hospitals, pharmacies, restaurants and stores',
    confirmAsk: {
      en: 'Please confirm someone will be there to receive it and move it into cold storage straight away, and share the receiving contact if it has changed.',
      hi: 'Kripya confirm karein ki delivery lete hi maal turant cold storage mein rakhne ke liye koi hoga, aur receiving contact badla ho to bata dein.',
    },
    driverAsk: {
      en: 'where are you now, what time will you reach, and what is the reefer temperature reading?',
      hi: 'abhi aap kahan ho, kitne baje pahunchoge, aur reefer ka temperature kitna dikh raha hai?',
    },
    aiNotes:
      'Temperature is everything. Ask drivers for the reefer temperature reading if they don\'t give it. A reading outside the safe range (chilled above 8°C, frozen above -15°C, unless the customer data says otherwise), a reefer/compressor fault, or a long unplanned stop is CRITICAL. A receiver who can\'t take the goods immediately is a warning.',
  },
  ecommerce: {
    id: 'ecommerce',
    label: 'E-commerce & parcels',
    description: 'parcels and online orders to homes and businesses',
    confirmAsk: {
      en: 'Please confirm someone will be available at the address to receive it, or reply with a better time.',
      hi: 'Kripya confirm karein ki address par lene ke liye koi hoga, ya koi behtar time bata dein.',
    },
    driverAsk: { en: 'where are you now and what time will you reach the address?', hi: 'abhi aap kahan ho aur address par kitne baje pahunchoge?' },
    aiNotes:
      'Customers are often individuals: be extra polite and simple. Common requests: change the delivery time, leave with a neighbour or security, give directions or a landmark. Address problems (can\'t find, wrong address) are a warning. Never discuss payment details; cash-on-delivery questions go to a human.',
  },
  tankers: {
    id: 'tankers',
    label: 'Tankers & bulk liquids',
    description: 'fuel, chemicals, water and other bulk liquids by tanker to industrial sites, stations and plants',
    confirmAsk: {
      en: 'Please confirm the receiving tank has enough space and the unloading point is ready, and share the site contact if it has changed.',
      hi: 'Kripya confirm karein ki receiving tank mein jagah hai aur unloading point ready hai, aur site contact badla ho to bata dein.',
    },
    driverAsk: { en: 'where are you now and what time will you reach the unloading point?', hi: 'abhi aap kahan ho aur unloading point par kitne baje pahunchoge?' },
    aiNotes:
      'Safety first. Any leak, spill, smell of gas, fire, accident or seal problem is CRITICAL: tell the driver to stop safely and that dispatch will call immediately. A receiving tank without space or a site refusing unloading is critical too. Quantities are litres, kilolitres or tonnes.',
  },
  general: {
    id: 'general',
    label: 'General freight',
    description: 'full and part truck loads between businesses',
    confirmAsk: {
      en: 'Please reply to confirm you are ready to receive it, and share the contact number at the location if it has changed.',
      hi: 'Kripya reply karke confirm karein ki aap delivery lene ke liye ready hain, aur location ka contact number badla ho to bata dein.',
    },
    driverAsk: { en: 'where are you now and what time will you reach?', hi: 'abhi aap kahan ho aur kitne baje pahunchoge?' },
    aiNotes: 'Use neutral terms: load, consignment, delivery location. Breakdowns, accidents and refused deliveries are critical.',
  },
};

export type RegionId = 'IN' | 'AE';

export interface RegionPreset {
  id: RegionId;
  label: string;
  defaultCountryCode: string;
  timezone: string;
  defaultLanguage: string;
  /** null = keep the languages from config/dispatch.json (the India set). */
  languages: VoiceLanguage[] | null;
}

const el = (code: string, name: string, extra: Partial<VoiceLanguage> = {}): VoiceLanguage => ({
  code,
  name,
  ttsProvider: 'ElevenLabs',
  transcriptionProvider: 'Deepgram',
  speechModel: 'nova-3-general',
  ...extra,
});
const google = (code: string, name: string, voice: string, extra: Partial<VoiceLanguage> = {}): VoiceLanguage => ({
  code,
  name,
  ttsProvider: 'Google',
  voice,
  transcriptionProvider: 'Google',
  speechModel: 'telephony',
  ...extra,
});

export const REGIONS: Record<RegionId, RegionPreset> = {
  IN: { id: 'IN', label: 'India', defaultCountryCode: '+91', timezone: 'Asia/Kolkata', defaultLanguage: 'hi-IN', languages: null },
  AE: {
    id: 'AE',
    label: 'UAE',
    defaultCountryCode: '+971',
    timezone: 'Asia/Dubai',
    defaultLanguage: 'en-US',
    // UAE drivers and site staff: English, Arabic, Hindi/Urdu, Malayalam, Bengali, Tamil.
    languages: [
      el('en-US', 'English', { transcriptionLanguage: 'multi', style: 'Simple international English; many people are non-native speakers.' }),
      el('ar-AE', 'Arabic', { transcriptionProvider: 'Google', speechModel: 'telephony', style: 'Polite Gulf-friendly Arabic, in Arabic script.' }),
      el('hi-IN', 'Hindi / Hinglish', { transcriptionLanguage: 'multi', style: 'Everyday Hindi; mix English words like truck, site, location as people do.' }),
      google('ur-IN', 'Urdu', 'ur-IN-Chirp3-HD-Aoede', { style: 'Polite conversational Urdu; many Pakistani drivers.' }),
      google('ml-IN', 'Malayalam', 'ml-IN-Chirp3-HD-Aoede'),
      google('bn-IN', 'Bengali', 'bn-IN-Chirp3-HD-Aoede'),
      el('ta-IN', 'Tamil', { transcriptionProvider: 'Google', speechModel: 'telephony' }),
    ],
  },
};

export const industryOf = (id?: string): IndustryProfile => INDUSTRIES[(id as IndustryId) || 'general'] || INDUSTRIES.general;
