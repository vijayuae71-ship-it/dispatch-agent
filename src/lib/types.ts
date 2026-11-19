// Core data model for the AI dispatcher.

export type Party = 'client' | 'driver' | 'dispatcher';

export type DeliveryStatus =
  | 'scheduled' // planned, client not yet confirmed
  | 'confirmed' // client confirmed the site is ready
  | 'en_route' // driver on the way, ETA on time
  | 'delayed' // driver on the way, ETA late
  | 'arrived' // truck at site
  | 'delivered'
  | 'rescheduled' // client asked for another time
  | 'issue' // breakdown, site refused, accident… needs a human
  | 'cancelled';

export const CLOSED: DeliveryStatus[] = ['delivered', 'cancelled'];

export interface Contact {
  name: string;
  /** E.164, e.g. +919876543210 */
  phone: string;
  /** BCP-47 code, e.g. hi-IN. Optional; the bot follows whatever they write in. */
  language?: string;
}

export interface Delivery {
  /** Usually the order number. */
  id: string;
  orderNo: string;
  material: string;
  client: Contact;
  site: { name: string; area?: string; contact?: string };
  truck: string;
  driver: Contact;
  /** Planned arrival at site, ISO 8601. */
  plannedAt: string;
  /** Latest expected arrival, ISO 8601. */
  eta?: string;
  status: DeliveryStatus;
  lastLocation?: string;
  lastDriverUpdateAt?: string;
  clientConfirmedAt?: string;
  rescheduledTo?: string;
  issue?: string;
  notes?: string;
  /** Bookkeeping for the rules engine, so each step happens once. */
  flags: {
    clientAskedAt?: string;
    clientCalledAt?: string;
    driverAskedAt?: string;
    driverCalledAt?: string;
    lateAlertedAt?: string;
    noReplyAlertedClientAt?: string;
    noReplyAlertedDriverAt?: string;
  };
  source?: 'sheet' | 'api' | 'demo';
  sheetRow?: number;
  updatedAt: string;
}

export type Channel = 'whatsapp' | 'call' | 'system';

export interface Message {
  id: string;
  phone: string;
  party: Party | 'unknown';
  direction: 'in' | 'out';
  channel: Channel;
  text: string;
  at: string;
  deliveryIds?: string[];
}

/** One conversation per phone number (a driver or client can have several deliveries). */
export interface Thread {
  phone: string;
  name?: string;
  party: Party | 'unknown';
  language?: string;
  messages: Message[];
  /** WhatsApp only allows free-form business messages within 24h of their last message. */
  lastInboundAt?: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  deliveryId?: string;
  severity: 'info' | 'warning' | 'critical';
  text: string;
  at: string;
  resolved?: boolean;
}

/** A voice call placed when someone doesn't answer on WhatsApp. */
export interface CallSession {
  id: string;
  phone: string;
  party: Party;
  deliveryIds: string[];
  reason: string;
  language: string;
  status: 'ringing' | 'in_progress' | 'completed' | 'failed';
  /** Claude conversation history, append-only. */
  messages: unknown[];
  transcript: { role: 'bot' | 'person'; text: string; at: string }[];
  turns: number;
  pendingCaller?: string[];
  twilioSid?: string;
  startedAt: string;
  endedAt?: string;
}

/** Structured changes the AI extracted from a message or call. */
export interface DeliveryUpdate {
  deliveryId: string;
  status: DeliveryStatus | null;
  /** Minutes from now until arrival, if the person gave an ETA. */
  etaMinutes: number | null;
  location: string | null;
  issue: string | null;
  siteContact: string | null;
  /** ISO 8601 with offset, if the client asked to move the delivery. */
  rescheduleTo: string | null;
  confirmed: boolean | null;
}

export interface AgentAlert {
  deliveryId: string | null;
  severity: 'info' | 'warning' | 'critical';
  text: string;
}
