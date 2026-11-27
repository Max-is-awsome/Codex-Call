import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';

const origin = 'https://claw-messenger.onrender.com';
const incoming = z.object({ type: z.literal('message'), from: z.string(), text: z.string().max(4100),
  messageId: z.string().min(1).max(250), service: z.string().optional(), isGroup: z.boolean().optional(),
  isFromMe: z.boolean().optional(), fromMe: z.boolean().optional(), direction: z.string().optional(),
  replyTo: z.object({ messageId: z.string() }).optional(), sentAt: z.string().optional(),
});
export type ClawMessage = z.infer<typeof incoming>;
const reaction = z.object({ type: z.literal('reaction'), from: z.string(), messageId: z.string().min(1).max(250),
  reactionType: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom']), remove: z.boolean().optional(), added: z.boolean().optional(), isGroup: z.boolean().optional(),
});
export type ClawReaction = z.infer<typeof reaction>;
export const replyReactions = ['like', 'dislike', 'love'] as const;
export type ReplyReaction = typeof replyReactions[number];
export function parseClawReaction(frame: unknown, phone: string) {
  const r = reaction.safeParse(frame);
  if (r.success && r.data.from === phone && !r.data.remove && r.data.added !== false && !r.data.isGroup) return r.data;
}
export function parseClawMessage(frame: unknown, phone: string) {
  const result = incoming.safeParse(frame);
  if (!result.success) return;
  const m = result.data;
  if (m.from !== phone || m.isGroup || m.isFromMe || m.fromMe || m.direction && !['inbound', 'incoming'].includes(m.direction)
    || m.service && m.service.toLowerCase() !== 'imessage' || !m.text.trim()) return;
  return m;
}

export class Claw {
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private attempt = 0;

  constructor(private config: Config, private onReply: (message: ClawMessage) => void, private onReaction?: (reaction: ClawReaction) => void) {}

  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  get phone() { return this.config.USER_PHONE_NUMBER; }

  start() {
    const key = this.config.CLAW_API_KEY;
    if (!key || this.stopped || this.socket) return;
    const url = new URL('wss://claw-messenger.onrender.com/ws');
    url.searchParams.set('key', key);
    const socket = this.socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 256 * 1024, followRedirects: false });
    socket.on('open', () => {
      console.info('[Claw] WebSocket connected');
      let alive = true;
      socket.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.send('{"type":"ping"}');
      }, 30000);
      socket.on('message', data => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame?.type === 'ping') { socket.send('{"type":"pong"}'); return; }
          if (frame?.type === 'pong') { alive = true; this.attempt = 0; return; }
          if (frame?.type === 'reaction') {
            const received = parseClawReaction(frame, this.phone);
            if (received) this.onReaction?.(received);
            return;
          }
          const message = parseClawMessage(frame, this.phone);
          if (message) this.onReply(message);
        } catch { console.warn('[Claw] Could not process WebSocket message'); }
      });
    });
    socket.on('error', () => console.warn('[Claw] WebSocket connection error'));
    socket.on('close', () => {
      this.socket = undefined;
      clearInterval(this.heartbeat);
      if (!this.stopped) this.retry = setTimeout(() => this.start(), Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)));
    });
  }

  async request(path: string, body?: object) {
    const key = this.config.CLAW_API_KEY;
    if (!key) throw new Error('Claw API key is missing');
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Claw HTTP ${response.status}`);
    return response.json();
  }

  async send(text: string) {
    if (!this.connected) throw new Error('Claw listener is offline');
    const result = await this.request('/api/agent/send-message', { phone_number: this.phone, text, service: 'iMessage', claim_route: false });
    if (result?.ok === false || result?.status === 'failed') throw new Error('Claw rejected the send');
    return result;
  }

  typing(active: boolean) {
    if (!this.connected) return;
    this.socket?.send(JSON.stringify({ type: active ? 'typing.start' : 'typing.stop', to: this.phone }), () => {});
  }

  async react(messageId: string, reactionType: ReplyReaction): Promise<boolean> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Claw listener is offline');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', receive);
        socket.off('close', uncertain);
      };
      const uncertain = () => { cleanup(); reject(new Error('Reaction result is uncertain')); };
      const receive = (data: WebSocket.RawData) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame?.type !== 'reaction.result' || frame.id !== id) return;
        cleanup();
        resolve(frame.ok === true);
      };
      const timer = setTimeout(uncertain, 3500);
      socket.on('message', receive);
      socket.once('close', uncertain);
      socket.send(JSON.stringify({ type: 'reaction', id, messageId, reactionType, remove: false }), error => {
        if (error) uncertain();
      });
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.socket?.terminate();
  }
}
