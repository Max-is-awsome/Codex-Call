import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ClawReaction } from './claw.js';

const session = z.object({ id: z.string(), cwd: z.string(), updatedAt: z.number(), summary: z.string(), ended: z.boolean() });
const event = z.object({
  id: z.string(), sessionId: z.string(), key: z.string(), question: z.string(),
  kind: z.enum(['question', 'approval', 'stop']), createdAt: z.number(), dueAt: z.number(),
  acknowledged: z.boolean(), cancelled: z.boolean(), reply: z.string().nullable(),
  callAttempted: z.boolean(), callSid: z.string().nullable(), error: z.string().nullable(), ackToken: z.string(),
  decision: z.enum(['allow', 'deny']).nullable(),
  clawMessageId: z.string().optional(), clawSentAt: z.number().optional(), clawReplyId: z.string().optional(), textDecision: z.boolean().optional(),
});
const instruction = z.object({ id: z.string(), sessionId: z.string(), text: z.string(), delivered: z.boolean(), uncertain: z.boolean(), createdAt: z.number() });
const schema = z.object({ version: z.literal(1), sessions: z.record(z.string(), session), events: z.record(z.string(), event), instructions: z.array(instruction),
  statusTexts: z.array(z.object({ messageId: z.string(), sessionId: z.string() })).optional(),
});
export type BridgeEvent = z.infer<typeof event>;

export class Router {
  state: z.infer<typeof schema> = { version: 1, sessions: {}, events: {}, instructions: [] };
  constructor(private path: string) {
    try { this.state = schema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  save() {
    const cutoff = Date.now() - 7 * 86400000;
    for (const [id, e] of Object.entries(this.state.events)) if (e.createdAt < cutoff) delete this.state.events[id];
    this.state.instructions = this.state.instructions.filter(i => !i.delivered || i.createdAt >= cutoff);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  touch(id: string, cwd: string, summary?: string, ended = false) {
    this.state.sessions[id] = { id, cwd, summary: summary ?? this.state.sessions[id]?.summary ?? '', updatedAt: Date.now(), ended };
    this.save();
  }
  active() {
    return Object.values(this.state.sessions).filter(s => !s.ended && Date.now() - s.updatedAt < 86400000).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  create(sessionId: string, key: string, question: string, kind: BridgeEvent['kind'], delay: number, now = Date.now()) {
    if (!this.state.sessions[sessionId] || this.state.sessions[sessionId].ended) throw new Error('Unknown or ended session');
    const previous = Object.values(this.state.events).find(e => e.sessionId === sessionId && e.key === key);
    if (previous) return { event: previous, fresh: false };
    this.cancel(sessionId);
    const e: BridgeEvent = { id: randomUUID(), sessionId, key, question, kind, createdAt: now, dueAt: now + delay * 1000,
      acknowledged: false, cancelled: false, reply: null, decision: null, callAttempted: false, callSid: null, error: null, ackToken: randomBytes(32).toString('hex') };
    this.state.events[e.id] = e;
    this.save();
    return { event: e, fresh: true };
  }
  cancel(sessionId: string) {
    const calls: string[] = [];
    for (const e of Object.values(this.state.events)) if (e.sessionId === sessionId && !e.cancelled) {
      e.cancelled = true;
      if (e.callSid && e.reply === null) calls.push(e.callSid);
    }
    this.save();
    return calls;
  }
  due(now = Date.now()) {
    return Object.values(this.state.events).filter(e => e.kind !== 'stop' && !e.cancelled && !e.acknowledged && e.reply === null && !e.callAttempted && e.dueAt <= now);
  }
  claim(id: string) {
    const e = this.state.events[id];
    if (!e || !this.due().includes(e)) return null;
    // Persist before dialing: an uncertain REST outcome must never cause duplicate paid calls.
    e.callAttempted = true;
    this.save();
    return e;
  }
  ack(id: string) {
    const e = this.state.events[id];
    if (!e) throw new Error('Unknown event');
    e.acknowledged = true;
    this.save();
    return e;
  }
  reply(id: string, text: string, decision: 'allow' | 'deny' | null = null) {
    const e = this.state.events[id];
    if (!e || e.cancelled) throw new Error('This question has expired');
    if (e.reply !== null) return e;
    e.reply = text; e.acknowledged = true; e.decision = decision;
    this.save();
    return e;
  }
  textReply(message: { text: string; messageId: string; replyTo?: { messageId: string }; sentAt?: string }) {
    const events = Object.values(this.state.events);
    if (events.some(e => e.clawReplyId === message.messageId || e.clawMessageId === message.messageId)) return;
    const [ , reference, referencedText ] = message.text.trim().match(/^([a-f0-9]{8})\s+([\s\S]+)$/i) ?? [];
    const e = events.reverse().find(e => e.kind !== 'stop' && !e.key.startsWith('desktop-approval:') && (message.replyTo ? message.replyTo.messageId === e.clawMessageId
      : reference ? reference.toLowerCase() === e.id.slice(0, 8) : true));
    const sent = message.sentAt ? Date.parse(message.sentAt) : undefined;
    if (!e || e.cancelled || e.acknowledged || e.reply !== null || Date.now() - e.createdAt >= 3600000
      || (!message.replyTo && !reference && !e.clawSentAt && !e.clawMessageId)
      || sent !== undefined && (!Number.isFinite(sent) || sent < e.createdAt - 1000)) return;
    const text = (referencedText ?? message.text).trim();
    if (!text || text.length > 4000) return;
    const answer = text.toLowerCase();
    const decision = e.kind === 'approval' && e.textDecision && Date.now() <= e.dueAt
      ? /^(y|yes)$/.test(answer) ? 'allow' : /^(n|no)$/.test(answer) ? 'deny' : null : null;
    e.clawReplyId = message.messageId;
    return this.reply(e.id, text, decision);
  }
  followUp(message: { text: string; messageId: string; replyTo?: { messageId: string }; sentAt?: string }) {
    const id = `claw:${message.messageId}`;
    const text = message.text.trim();
    if (!text || text.length > 4000 || /^(?:(?:[a-f0-9]{8})\s+)?(?:y|yes|n|no)[.!]?$/i.test(text)) return;
    if (this.state.instructions.some(i => i.id === id) || Object.values(this.state.events).some(e => e.clawReplyId === message.messageId || e.clawMessageId === message.messageId)) return;
    const sent = message.sentAt === undefined ? Date.now() : Date.parse(message.sentAt);
    if (!Number.isFinite(sent) || Date.now() - sent > 3600000) return;
    const referenced = message.replyTo && (Object.values(this.state.events).find(e => e.clawMessageId === message.replyTo!.messageId)
      ?? this.state.statusTexts?.find(e => e.messageId === message.replyTo!.messageId));
    if (message.replyTo && !referenced) return;
    const session = referenced ? this.state.sessions[referenced.sessionId] : this.active();
    if (!session || session.ended) return;
    return this.queue(session.id, text, id);
  }
  rememberStatusText(messageId: string, sessionId = this.active()?.id) {
    if (!sessionId) return;
    this.state.statusTexts = [...(this.state.statusTexts ?? []).slice(-167), { messageId, sessionId }];
    this.save();
  }
  reactionTarget(sessionId: string, cwd: string, text: string) {
    const session = this.state.sessions[sessionId];
    if (!session || session.ended || session.cwd !== cwd) return;
    const cutoff = Date.now() - 3600000;
    const matches = new Set([
      ...this.state.instructions
        .filter(i => i.sessionId === sessionId && i.id.startsWith('claw:') && i.text === text && i.createdAt >= cutoff)
        .map(i => i.id.slice('claw:'.length)),
      ...Object.values(this.state.events)
        .filter(e => e.sessionId === sessionId && e.kind === 'question' && e.reply === text && e.createdAt >= cutoff)
        .flatMap(e => e.clawReplyId ? [e.clawReplyId] : []),
    ]);
    if (matches.size === 1) return matches.values().next().value;
  }
  recordReaction(reaction: ClawReaction) {
    const target = Object.values(this.state.events).find(e => e.clawMessageId === reaction.messageId)
      ?? this.state.statusTexts?.find(e => e.messageId === reaction.messageId);
    if (!target || !this.state.sessions[target.sessionId] || this.state.sessions[target.sessionId].ended) return;
    const id = `claw-reaction:${reaction.messageId}:${reaction.reactionType}`;
    if (this.state.instructions.some(i => i.id === id)) return;
    const text = {
      like: 'Okay. (The user gave your iMessage a thumbs-up.)', love: 'The user hearted your iMessage.',
      dislike: 'The user gave your iMessage a thumbs-down.', laugh: 'The user laughed at your iMessage.',
      emphasize: 'The user emphasized your iMessage.', question: 'The user reacted to your iMessage with a question mark.', custom: 'The user reacted to your iMessage with an emoji.',
    }[reaction.reactionType];
    return this.queue(target.sessionId, text, id);
  }
  queue(sessionId: string, text: string, id: string = randomUUID()) {
    if (!this.state.sessions[sessionId] || this.state.sessions[sessionId].ended) throw new Error('Session has ended');
    const existing = this.state.instructions.find(i => i.id === id);
    if (existing) return existing;
    const item = { id, sessionId, text, delivered: false, uncertain: false, createdAt: Date.now() };
    this.state.instructions.push(item); this.save(); return item;
  }
  pending(sessionId: string) { return this.state.instructions.filter(i => i.sessionId === sessionId && !i.delivered); }
  delivered(sessionId: string, ids: string[]) {
    for (const i of this.state.instructions) if (i.sessionId === sessionId && ids.includes(i.id)) i.delivered = true;
    this.save();
  }
}
