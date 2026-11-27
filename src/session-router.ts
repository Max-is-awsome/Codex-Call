import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ClawReaction } from './claw.js';
import type { SessionChoice } from './codex-client.js';

const session = z.object({ id: z.string(), cwd: z.string(), updatedAt: z.number(), summary: z.string(), ended: z.boolean(),
  transcript: z.string().optional(), alertedUsageTurn: z.string().optional(), title: z.string().optional(),
  notifiedDoneTurn: z.string().optional(), pendingDoneTurn: z.string().optional(), remoteTurn: z.string().optional(),
});
const event = z.object({
  id: z.string(), sessionId: z.string(), key: z.string(), question: z.string(),
  kind: z.enum(['question', 'approval', 'stop']), createdAt: z.number(), dueAt: z.number(),
  acknowledged: z.boolean(), cancelled: z.boolean(), reply: z.string().nullable(),
  callAttempted: z.boolean(), callSid: z.string().nullable(), error: z.string().nullable(), ackToken: z.string(),
  decision: z.enum(['allow', 'deny']).nullable(),
  clawMessageId: z.string().optional(), clawSentAt: z.number().optional(), clawReplyId: z.string().optional(), textDecision: z.boolean().optional(),
  approvalCommand: z.string().optional(), reactionClaimed: z.boolean().optional(),
});
const instruction = z.object({ id: z.string(), sessionId: z.string(), text: z.string(), delivered: z.boolean(), uncertain: z.boolean(), createdAt: z.number(), remote: z.boolean().optional() });
const mirror = z.object({
  messageId: z.string(), text: z.string(), receivedAt: z.number(), turnId: z.string().optional(),
  reaction: z.enum(['acknowledgment', 'final']).optional(), finalText: z.string().optional(),
  replyGuidanceTurn: z.string().optional(),
});
export type MirroredReply = z.infer<typeof mirror>;
const schema = z.object({ version: z.literal(1), sessions: z.record(z.string(), session), events: z.record(z.string(), event), instructions: z.array(instruction),
  statusTexts: z.array(z.object({ messageId: z.string(), sessionId: z.string() })).optional(),
  mirroredReplies: z.record(z.string(), mirror).optional(),
  selectedSessionId: z.string().optional(),
  textSessionId: z.string().optional(),
  sessionMenu: z.array(z.string()).optional(),
  handledMenuMessages: z.array(z.string()).optional(),
});
export type BridgeEvent = z.infer<typeof event>;
export const questionLifetimeMs = 9 * 60_000;

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
  touch(id: string, cwd: string, summary?: string, ended = false, transcript?: string) {
    const previous = this.state.sessions[id];
    this.state.sessions[id] = { ...previous, id, cwd, summary: summary ?? previous?.summary ?? '', updatedAt: Date.now(), ended,
      transcript: transcript ?? previous?.transcript };
    this.save();
  }
  selected() {
    const id = this.state.selectedSessionId;
    return id ? this.state.sessions[id] : undefined;
  }
  textTarget() {
    const id = this.state.textSessionId ?? this.state.selectedSessionId;
    return id ? this.state.sessions[id] : undefined;
  }
  rememberSession(choice: SessionChoice) {
    const previous = this.state.sessions[choice.id];
    this.state.sessions[choice.id] = {
      ...previous, id: choice.id, cwd: choice.cwd, title: choice.title,
      updatedAt: previous?.updatedAt ?? 0, summary: previous?.summary ?? '', ended: previous?.ended ?? false,
    };
  }
  select(choice: SessionChoice) {
    this.rememberSession(choice);
    this.state.selectedSessionId = choice.id;
    this.state.textSessionId = undefined;
    this.state.sessionMenu = undefined;
    this.save();
  }
  create(sessionId: string, key: string, question: string, kind: BridgeEvent['kind'], delay: number, now = Date.now()) {
    if (!this.state.sessions[sessionId] || this.state.sessions[sessionId].ended) throw new Error('Unknown or ended session');
    const previous = Object.values(this.state.events).find(e => e.sessionId === sessionId && e.key === key);
    if (previous) return { event: previous, fresh: false };
    if (!(kind === 'approval' && key.startsWith('desktop-approval:'))) this.cancel(sessionId);
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
    return Object.values(this.state.events).filter(e => e.kind !== 'stop' && !e.cancelled && !e.acknowledged && e.reply === null && !e.callAttempted
      && e.dueAt <= now && (e.kind !== 'question' || now - e.createdAt < questionLifetimeMs));
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
    const targetId = this.textTarget()?.id;
    if (!message.replyTo && !reference && !targetId) {
      const waiting = new Set(events.filter(e => e.kind === 'question' && !e.cancelled && !e.acknowledged && e.reply === null
        && Date.now() - e.createdAt < questionLifetimeMs && (e.clawSentAt || e.clawMessageId)).map(e => e.sessionId));
      if (waiting.size > 1) return;
    }
    const e = events.reverse().find(e => e.kind !== 'stop' && !e.key.startsWith('desktop-approval:') && (message.replyTo ? message.replyTo.messageId === e.clawMessageId
      : reference ? reference.toLowerCase() === e.id.slice(0, 8)
      : !e.cancelled && !e.acknowledged && e.reply === null && (!targetId || e.sessionId === targetId)));
    const sent = message.sentAt ? Date.parse(message.sentAt) : undefined;
    if (!e || e.cancelled || e.acknowledged || e.reply !== null || Date.now() - e.createdAt >= (e.kind === 'question' ? questionLifetimeMs : 3600000)
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
    const session = referenced ? this.state.sessions[referenced.sessionId] : this.textTarget();
    if (!session || session.ended) return;
    return this.queue(session.id, text, id);
  }
  rememberStatusText(messageId: string, sessionId = this.textTarget()?.id) {
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
  queue(sessionId: string, text: string, id: string = randomUUID()): z.infer<typeof instruction> {
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
