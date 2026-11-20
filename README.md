# Dispatch Agent

An AI dispatcher for any logistics operation: building materials, FMCG distribution, cold chain, e-commerce, bulk goods. India first. It takes over the routine calls that dispatch desks make all day: confirming deliveries with clients, chasing drivers for location and ETA, and answering "where's my truck?". It does this over **WhatsApp first**, calls only when someone doesn't reply, and alerts a human dispatcher only when one is needed.

- **Customers order on WhatsApp:** "send 2 trucks to Wakad tomorrow 9 am" or "need 300 cartons at the Andheri store 10 am". The bot confirms with order numbers, the order appears on the board as **Needs truck**, and the clerks are alerted.
- **Clerks assign a truck in one line:** `assign 101 MH12AB1234 98765 43210 Ramesh`, or with the form on the console. The driver gets the trip on WhatsApp, and every customer contact gets the truck and driver details.
- **Customers** get a WhatsApp message before their delivery, asking them to confirm the site is ready and share the gate contact. They can ask about their truck at any time.
- **Drivers** get a short check-in when their ETA is due or missed, never on a fixed schedule. "Traffic hai, 45 min lagega" updates the ETA; "tyre puncture" raises a critical alert.
- **No reply after 20 minutes?** The bot calls them: a natural voice in their language that can be interrupted, through Twilio ConversationRelay, as a normal call or a WhatsApp call.
- **Dispatch clerks** see one live board. Every alert goes to **all clerks on WhatsApp**, numbered: a clerk replies `take 12` to own it (the others are told, so nobody doubles up), `done 12` to close it, and `list` for what's open. The same Take and Close buttons are on the console.
- **Several people per client** (site engineer, purchase manager…) can ask about their deliveries, and all of them get a WhatsApp update when a truck is delayed, arrives, or is delivered: the job the WhatsApp group used to do.
- **Languages:** Hindi and Hinglish, English, Marathi, Tamil, Telugu, Kannada, Bengali, Punjabi, Gujarati and Malayalam. The bot replies the way the person writes, including Roman-script Hinglish.
- **Order feed:** a Google Sheet the dispatcher already knows, or a JSON API for a transport-management system. Statuses are written back to the sheet.

## Demo in 2 minutes (no Twilio needed)

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... ADMIN_KEY=demo npm run dev
```

Open http://localhost:8080, enter `demo`, pick an industry (**Building materials · Pune** or **FMCG distribution · Mumbai**), then:

1. **Start demo day.** It's 9:00 AM at a Pune building-materials transporter with 5 trucks: cement, steel, M-sand, bricks. The bot immediately asks Patil Constructions to confirm their 11:00 AM delivery.
2. **Reply as the client.** Open their chat and type something like *"haan site ready hai, gate pe Sunil milega 98765 43210"*. The delivery turns **Confirmed** and the site contact is saved.
3. **+30 min.** Gurpreet's ETA is due, so the bot checks in. Reply *"traffic hai, 45 min lagega"*: his ETA moves and the card turns **Delayed**.
4. **+1 hour.** Suresh never answered his check-in, so the bot **calls** him. Open his chat, press **Answer**, and talk to it by typing. It speaks Marathi or Hindi and updates the board from what you say.
5. **Place an order** as a customer: *"send 2 trip OPC to Wakad Residency 3 pm"*. Then assign a truck from its card, or as clerk 🎧 Anita type `assign 101 MH12AB1234 9876543210 Ramesh`.
6. **Try a problem:** as a driver, type *"truck ka tyre puncture ho gaya"*. You get a critical **dispatcher alert**.

The KPI row shows how many messages and call lines the AI handled, which is the number to talk about with a transporter.

Deploy the demo to a shareable URL with `bash deploy.sh` and choose **demo** (see Deploy).

## How it works

```
Google Sheet / API ─► deliveries ─► rules (every minute) ─► WhatsApp template ──► client / driver
                                        │                         │ reply
                                        │ no reply in 20 min      ▼
                                        └──► call (ConversationRelay, streamed Claude) ─┐
   console board ◄── statuses, ETA, location, issues ◄── Claude extracts updates ◄─────┘
   dispatcher WhatsApp ◄── alerts (breakdown, unreachable, late, unconfirmed)
```

| Rule | When | What happens |
|---|---|---|
| Client confirmation | 2 h before planned arrival | WhatsApp: confirm site ready and contact |
| Client silent | 20 min after asking | Call. Still nothing? Alert the dispatcher. |
| Driver check-in | ETA within 15 min with no update, ETA passed, or no update for 90 min | WhatsApp: where are you, ETA? |
| Driver silent | 20 min after asking | Call. Still nothing? **Critical** alert. |
| Running late | ETA 45+ min after planned | Alert the dispatcher once |

Company settings are in `config/dispatch.json`: `businessDescription` (one line, e.g. "FMCG cartons to retail stores", so the AI uses your industry's words), `defaultCountryCode` (`+91`, or `+971` for the UAE), all timings, along with `shareDriverPhone`: clients get the driver's number when they ask, which is normal practice; set it to `false` to have the bot pass messages instead. Unknown numbers never get it.

Alerts the AI raises are de-duplicated: a repeat for the same delivery within 30 minutes is skipped unless it's more serious.

**Cost control (important for India):**
- WhatsApp messages cost paise, while voice minutes cost rupees, so voice is only the fallback.
- Routine turns run on **Claude Haiku 5.5** (`MODEL`).
- First-contact messages are fixed templates, not AI-written, so they cost nothing to generate.

## Going live

1. **Twilio WhatsApp sender.** Register a WhatsApp Business sender in Twilio (Messaging → Senders → WhatsApp senders) with a number that isn't on personal WhatsApp. Set its webhooks:
   - When a message comes in: `POST {PUBLIC_URL}/twilio/whatsapp`
   - Status callback: `POST {PUBLIC_URL}/twilio/message-status`
2. **Templates.** WhatsApp only lets a business start a conversation with a pre-approved template. In Twilio's Content Template Builder, create these (category **Utility**), get them approved, and put each Content SID in the matching env var:

   | Env var | Text (variables in order) |
   |---|---|
   | `TEMPLATE_CLIENT_CONFIRM_EN` | Hello {{1}}, this is {{2}} dispatch. Your order {{3}} ({{4}}) is planned to reach {{5}} around {{6}} on truck {{7}}. Please reply to confirm the site is ready to unload, and share the site contact number if it has changed. |
   | `TEMPLATE_CLIENT_CONFIRM_HI` | Namaste {{1}}, {{2}} dispatch se. Aapka order {{3}} ({{4}}) {{5}} par lagbhag {{6}} baje truck {{7}} se pahunchega. Kripya reply karke confirm karein ki site unloading ke liye ready hai, aur site contact number badla ho to bata dein. |
   | `TEMPLATE_DRIVER_ETA_EN` | Hello {{1}}, {{2}} dispatch here. Order {{3}} to {{4}}, truck {{5}}: where are you now and what time will you reach? Please reply when safely stopped. |
   | `TEMPLATE_DRIVER_ETA_HI` | Namaste {{1}}, {{2}} dispatch se. Order {{3}}, {{4}} ke liye, truck {{5}}: abhi aap kahan ho aur kitne baje pahunchoge? Gaadi rok kar reply karein. |
   | `TEMPLATE_DISPATCHER_ALERT_EN` | ⚠️ {{1}} |
   | `TEMPLATE_CLIENT_UPDATE_EN` | Update on order {{1}} to {{2}}: {{3}}. |
   | `TEMPLATE_CLIENT_UPDATE_HI` | Order {{1}} ({{2}}) update: {{3}}. |
   | `TEMPLATE_DRIVER_TRIP_EN` | New trip from {{1}}: order {{2}}, {{3}} to {{4}}, needed by {{5}}. Truck {{6}}. Please reply here with updates on the way. |
   | `TEMPLATE_DRIVER_TRIP_HI` | {{1}} se naya trip: order {{2}}, {{3}} {{4}} tak, {{5}} tak pahunchana hai. Truck {{6}}. Raste ki update yahan reply karein. |

   Within 24 hours of someone's last message, the same texts go out as normal messages, so no template is needed then.
3. **Calls (optional).**
   - **WhatsApp calls:** set `WHATSAPP_CALLS=true`. People must first grant your business permission to call them, which the transporter collects at onboarding.
   - **Normal calls:** set `TWILIO_VOICE_FROM`.
   - **No calls:** set `CALLS_ENABLED=false`, and the bot alerts the dispatcher instead of calling.
4. **Order feed.** Create a sheet with a tab named `Deliveries` and these columns (any order):
   - **Input:** `Order`, `Material`, `Client`, `Client Phone`, `Client Language`, `Other Contacts` (e.g. `Sunil (Site engineer) 98765 43210; Meera 98123 45678`), `Site`, `Site Area`, `Truck`, `Driver`, `Driver Phone`, `Driver Language`, `Planned` (e.g. `2026-11-20 14:30` or `20/11/2026 2:30 PM`), `Notes`
   - **Written by the bot:** `Status`, `ETA`, `Location`, `Last Update`, `Issue`, `Site Contact`

   Share the sheet with the service account (`dispatch-agent@<project>.iam.gserviceaccount.com`, Editor) and set `SHEET_ID`. Typing a status like `delivered` in the sheet overrides the bot. Ten-digit numbers are treated as Indian (+91).
5. **Deploy** with `bash deploy.sh` and choose **live**.

## Deploy (Cloud Run)

Run in [Google Cloud Shell](https://shell.cloud.google.com):

```bash
gh auth login
gh repo clone vijayuae71-ship-it/dispatch-agent && cd dispatch-agent
bash deploy.sh
```

| | Demo | Live |
|---|---|---|
| Needs | Anthropic API key | Anthropic key, Twilio WhatsApp sender and auth token, optional sheet |
| Data | In memory, resets on restart | Firestore |
| Messages and calls | Shown in the console only | Real WhatsApp and calls |

The service runs as **one instance** (`--max-instances=1`), because the rules engine runs inside it. That comfortably handles hundreds of deliveries a day. Region `us-east4` gives the shortest pauses on calls; `asia-south1` keeps data in India.

## API

All `/api/*` endpoints need the header `x-admin-key: $ADMIN_KEY`.

```
GET  /api/state                 board: deliveries, alerts, chats, calls, clock
POST /api/deliveries            { deliveries: [{ id, material, truck, plannedAt (ISO), client: {name, phone, language?}, driver: {…}, site: {name, area?, contact?} }] }
POST /api/deliveries/assign     { ref, truck, driverPhone, driverName?, clerk? }
POST /api/alerts/assign         { id, clerk }
POST /api/alerts/resolve        { id, clerk? }
POST /api/tick                  run the rules now
POST /api/sync                  sync the Google Sheet now
POST /api/demo/start | advance { minutes } | message { phone, text } | call { callId, speech | hangup }   (demo mode only)
```

## Development

```bash
npm run typecheck
npm test     # 24 tests, no keys or network: rules, sheet parsing, templates, a full demo morning, the WhatsApp webhook, and a live call over the relay WebSocket (fake Claude)
```

| Path | What |
|---|---|
| `src/lib/rules.ts` | When to message, call or alert (pure, unit-tested) |
| `src/lib/engine.ts` | Inbound messages, applying updates, alerts, calls |
| `src/lib/agent.ts` | Claude: WhatsApp replies (structured outputs) and streamed voice turns |
| `src/relay.ts` | ConversationRelay WebSocket (barge-in, language switching) |
| `src/lib/sheets.ts` | Google Sheet sync |
| `src/lib/templates.ts` | First-contact WhatsApp templates |
| `public/console.html` | The console |

## Status and limits

- **Tested:** the rules, sheet parsing, templates, and full demo days with a simulated Claude, the WhatsApp webhook, and a call through the relay WebSocket. Not yet tested against real Twilio WhatsApp, real Claude replies, Google Sheets, or the Docker image.
- **Voice notes from drivers aren't transcribed yet;** the bot asks them to type. This is the most-requested next feature for drivers.
- **WhatsApp calling:** Twilio delivers WhatsApp calls to the same voice webhook as phone calls, so the existing ConversationRelay flow should work for them. Confirm it with a real call before relying on it.
- **Voices:** voice IDs and speech-model names for each language are placeholders until checked against Twilio's current ConversationRelay lists. Pick voices per company.
- **Compliance:** message clients and drivers only about their own deliveries, and collect WhatsApp opt-in and call permission at onboarding. These are service messages, not marketing. India's DPDP Act applies to the phone numbers and locations you store.
- **Roadmap:** voice-note transcription, GPS and telematics feeds (Fleetx, LocoNav and others) so drivers are only contacted for exceptions, a normal-phone fallback via an Indian provider (Exotel), CSV upload, and a daily summary report.
