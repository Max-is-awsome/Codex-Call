import { timingSafeEqual } from 'node:crypto';
import { RestClient } from '@signalwire/compatibility-api';
import type { Config } from './config.js';
import type { BridgeEvent } from './session-router.js';

export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export function xml(value: string) { return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!)); }
export function validSignature(config: Config, signature: string, path: string, body: Record<string, string>) {
  return RestClient.validateRequest(config.SIGNALWIRE_SIGNING_KEY, signature, config.PUBLIC_WEBHOOK_URL.replace(/\/$/, '') + path, body);
}
export class Providers {
  constructor(private config: Config) {}
  async signalwire(path: string, fields: Record<string, string>) {
    const c = this.config;
    const response = await fetch(`${c.SIGNALWIRE_SPACE_URL.replace(/\/$/, '')}/api/laml/2010-04-01/Accounts/${encodeURIComponent(c.SIGNALWIRE_PROJECT_ID)}/${path}`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${c.SIGNALWIRE_PROJECT_ID}:${c.SIGNALWIRE_API_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`SignalWire HTTP ${response.status}`);
    return response.json() as Promise<{ sid: string }>;
  }
  dial(e: BridgeEvent) {
    const c = this.config;
    return this.signalwire('Calls.json', { From: c.SIGNALWIRE_PHONE_NUMBER, To: c.USER_PHONE_NUMBER,
      Url: `${c.PUBLIC_WEBHOOK_URL.replace(/\/$/, '')}/voice/outbound?eventId=${e.id}`, Method: 'POST', Timeout: '30', TimeLimit: '300' });
  }
  hangup(sid: string) { return this.signalwire(`Calls/${encodeURIComponent(sid)}.json`, { Status: 'completed' }); }
}
