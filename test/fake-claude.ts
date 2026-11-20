// A stand-in for the Claude API, so tests run with no key and no network.
// It answers like the dispatcher would, keyed on words in the latest message.
import { createServer, type Server } from 'http';

export const seen: any[] = [];

function lastMessageText(body: any): string {
  const content = body.messages.at(-1).content;
  return typeof content === 'string' ? content : content.map((b: any) => b.text || '').join('\n');
}

function firstDeliveryId(text: string): string {
  return text.match(/Delivery (ORD-\d+)/)?.[1] || '';
}

/** The latest WhatsApp line: the conversation's last line before the instruction. */
function latestLine(text: string): string {
  const convo = text.split('Conversation so far (latest last):')[1] || '';
  const lines = convo.split('\n\nWrite your reply')[0].trim().split('\n');
  return lines[lines.length - 1] || '';
}

const upd = (id: string, o: Record<string, unknown>) => ({
  deliveryId: id,
  status: null,
  etaMinutes: null,
  location: null,
  issue: null,
  siteContact: null,
  rescheduleTo: null,
  confirmed: null,
  ...o,
});

function textReply(text: string) {
  const id = firstDeliveryId(text);
  const line = latestLine(text).toLowerCase();
  if (line.includes('puncture'))
    return {
      reply: 'Arre, dhyan rakhiye. Main dispatch ko bata rahi hoon, woh aapko call karenge.',
      language: 'hi-IN',
      updates: [upd(id, { status: 'issue', issue: 'Tyre puncture on the way' })],
      alert: { deliveryId: id, severity: 'critical', text: `Truck for ${id} has a tyre puncture; driver needs help.` },
    };
  if (line.includes('traffic'))
    return {
      reply: 'Theek hai, 45 minute note kar liya. Dhyan se chalaiye!',
      language: 'hi-IN',
      updates: [upd(id, { status: 'en_route', etaMinutes: 45, location: 'Chandni Chowk flyover' })],
      alert: null,
    };
  if (line.includes('site ready'))
    return {
      reply: 'Dhanyavaad! Site ready note kar liya. Gate par Sunil ji se milenge.',
      language: 'hi-IN',
      updates: [upd(id, { status: 'confirmed', confirmed: true, siteContact: line.includes('sunil') ? 'Sunil 9876543210' : null })],
      alert: null,
    };
  if (line.includes('send 2 trip'))
    return {
      reply: '',
      language: 'hi-IN',
      updates: [],
      alert: null,
      newOrders: [{ what: 'OPC cement', trips: 2, location: 'Wakad Residency', requestedAt: new Date(Math.floor(Date.now() / 3600000) * 3600000 + 8 * 3600000).toISOString() }],
    };
  if (line.includes('number')) {
    // Share the driver's number only if the dispatcher's data includes it.
    const phone = text.match(/Driver: [^\n(]+\(phone (\+\d+)\)/)?.[1];
    return phone
      ? { reply: `Driver ka number ${phone} hai.`, language: 'hi-IN', updates: [], alert: null }
      : { reply: 'Dispatcher aapko call karenge.', language: 'hi-IN', updates: [], alert: { deliveryId: id || null, severity: 'info', text: 'Caller asked for the driver number.' } };
  }
  if (line.includes('call back'))
    return { reply: 'Ji, dispatcher aapko call karenge.', language: 'hi-IN', updates: [], alert: { deliveryId: id, severity: 'info', text: `Client asked for a call back about ${id}.` } };
  if (line.includes('kab'))
    return { reply: 'Aapka truck 11:00 AM tak pahunchne ki ummeed hai.', language: 'hi-IN', updates: [], alert: null };
  return { reply: 'Okay, noted. Thank you!', language: 'en-IN', updates: [], alert: null };
}

function voiceReply(latest: string, all: string): string {
  const id = firstDeliveryId(all) || 'ORD-1042';
  if (latest.includes('They just picked up'))
    return '[[hi-IN]] नमस्ते सुरेश जी, मैं डिस्पैच से आशा बोल रही हूँ। आप अभी कहाँ हैं?\n<<<{"updates": [], "alert": null, "action": "continue"}>>>';
  if (latest.toLowerCase().includes('aundh'))
    return `ठीक है, बीस मिनट। धन्यवाद, ध्यान से चलाइए!\n<<<{"updates": [{"deliveryId": "${id}", "status": "en_route", "etaMinutes": 20, "location": "Aundh", "issue": null, "siteContact": null, "rescheduleTo": null, "confirmed": null}], "alert": null, "action": "end"}>>>`;
  return 'जी, फिर से बताइए?\n<<<{"updates": [], "alert": null, "action": "continue"}>>>';
}

export function startFakeClaude(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (!raw) return res.end('ok');
      const body = JSON.parse(raw);
      seen.push(body);
      const text = lastMessageText(body);
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'msg', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
            content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(textReply(text)) }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t: string, d: object) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const chunk of voiceReply(text, JSON.stringify(body.messages)).match(/[\s\S]{1,9}/g)!) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      ev('message_stop', {});
      res.end();
    });
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}
