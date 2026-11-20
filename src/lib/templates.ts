import { config } from './config';
import { fmtDateTime, fmtTime } from './clock';
import type { Delivery } from './types';

// Opening messages the bot sends first. WhatsApp only allows a business to
// start a conversation (or write after 24h of silence) with a pre-approved
// template, so these are fixed texts, not AI-written.
//
// To go live, create each one as a WhatsApp template in Twilio's Content
// Template Builder, using {{1}}, {{2}}… for the variables in the order listed,
// get it approved, and put its Content SID in the env var named in `envKey`.
// Inside the 24h window, the same text is sent as a normal message.

export type TemplateName = 'client_confirm' | 'driver_eta' | 'dispatcher_alert' | 'client_update' | 'driver_trip';
type Lang = 'en' | 'hi';

const TEXT: Record<TemplateName, Record<Lang, string>> = {
  client_confirm: {
    en: 'Hello {{1}}, this is {{2}} dispatch. Your order {{3}} ({{4}}) is planned to reach {{5}} around {{6}} on truck {{7}}. Please reply to confirm you are ready to receive it, and share the contact number at the location if it has changed.',
    hi: 'Namaste {{1}}, {{2}} dispatch se. Aapka order {{3}} ({{4}}) {{5}} par lagbhag {{6}} baje truck {{7}} se pahunchega. Kripya reply karke confirm karein ki aap delivery lene ke liye ready hain, aur location ka contact number badla ho to bata dein.',
  },
  driver_eta: {
    en: 'Hello {{1}}, {{2}} dispatch here. Order {{3}} to {{4}}, truck {{5}}: where are you now and what time will you reach? Please reply when safely stopped.',
    hi: 'Namaste {{1}}, {{2}} dispatch se. Order {{3}}, {{4}} ke liye, truck {{5}}: abhi aap kahan ho aur kitne baje pahunchoge? Gaadi rok kar reply karein.',
  },
  dispatcher_alert: {
    en: '⚠️ {{1}}',
    hi: '⚠️ {{1}}',
  },
  driver_trip: {
    en: 'New trip from {{1}}: order {{2}}, {{3}} to {{4}}, needed by {{5}}. Truck {{6}}. Please reply here with updates on the way.',
    hi: '{{1}} se naya trip: order {{2}}, {{3}} {{4}} tak, {{5}} tak pahunchana hai. Truck {{6}}. Raste ki update yahan reply karein.',
  },
  client_update: {
    en: 'Update on order {{1}} to {{2}}: {{3}}.',
    hi: 'Order {{1}} ({{2}}) update: {{3}}.',
  },
};

/** The status sentence that goes into client_update, in the contact's language. */
export function statusPhrase(status: 'delayed' | 'arrived' | 'delivered' | 'assigned', d: Delivery, language?: string): string {
  const hi = langOf(language) === 'hi';
  if (status === 'assigned') {
    const phone = config().shareDriverPhone && d.driver.phone ? `, ${d.driver.phone}` : '';
    return hi
      ? `truck ${d.truck} (driver ${d.driver.name || ''}${phone}) assign ho gaya hai, lagbhag ${fmtTime(d.plannedAt)} tak pahunchega`
      : `truck ${d.truck} (driver ${d.driver.name || ''}${phone}) is assigned, expected around ${fmtTime(d.plannedAt)}`;
  }
  if (status === 'delayed')
    return hi ? `truck ${d.truck} thoda late hai, ab lagbhag ${fmtTime(d.eta)} tak pahunchega` : `truck ${d.truck} is running late, now expected around ${fmtTime(d.eta)}`;
  if (status === 'arrived') return hi ? `truck ${d.truck} pahunch gaya hai` : `truck ${d.truck} has arrived`;
  return hi ? 'delivery poori ho gayi hai, dhanyavaad' : 'delivery completed, thank you';
}

function langOf(code?: string): Lang {
  return (code || config().defaultLanguage).toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

export function templateVars(name: TemplateName, d: Delivery | null, extra?: string): string[] {
  const c = config();
  if (name === 'dispatcher_alert') return [extra || ''];
  if (name === 'client_update') return d ? [d.orderNo, d.site.name, extra || ''] : [];
  if (name === 'driver_trip') return d ? [c.company, d.orderNo, d.material, d.site.name + (d.site.area ? `, ${d.site.area}` : ''), fmtDateTime(d.plannedAt), d.truck] : [];
  if (!d) return [];
  if (name === 'client_confirm') return [d.client.name, c.company, d.orderNo, d.material, d.site.name, fmtTime(d.plannedAt), d.truck];
  return [d.driver.name, c.company, d.orderNo, d.site.name, d.truck];
}

export function renderTemplate(name: TemplateName, language: string | undefined, vars: string[]): { text: string; envKey: string; lang: Lang } {
  const lang = langOf(language);
  const text = TEXT[name][lang].replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] ?? '');
  return { text, envKey: `TEMPLATE_${name.toUpperCase()}_${lang.toUpperCase()}`, lang };
}

/** All template texts, for the README and the Twilio template set-up. */
export const ALL_TEMPLATES = TEXT;
