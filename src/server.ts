import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { serverConfig, projectRoot, type Config } from './config.js';
import { Router, type BridgeEvent, type MirroredReply } from './session-router.js';
import { Providers, equalSecret, validSignature, xml } from './providers.js';
import { CodexClient, DeliveryError, effortLevels } from './codex-client.js';
import { bridgeVoice, type VoiceContext } from './voice-session.js';
import { Claw, replyReactions, type ClawMessage, type ReplyReaction } from './claw.js';
import { latestUsageLimit, rolloutPath } from './usage-limit.js';

const sessionId = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
const eventInput = z.object({ sessionId, key: z.string().min(1).max(500), question: text, kind: z.enum(['question', 'approval']), textDecision: z.boolean().optional() });
const activityInput = z.object({ sessionId, cwd: z.string().max(4096), summary: z.string().max(4000).optional(), ended: z.boolean().optional(), cancel: z.boolean().optional(), transcript: z.string().max(4096).optional() });

export function createBridge(c: Config, router: Router, providers = new Providers(c), codex = new CodexClient(), Messenger = Claw) {
  const startedAt = Date.now();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }); next(); });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/internal', (req, res, next) => {
    if (!equalSecret(req.get('authorization') ?? '', `Bearer ${c.BRIDGE_TOKEN}`)) { res.sendStatus(401); return; }
    next();
  });
  const endCalls = async (calls: string[]) => { for (const sid of calls) await providers.hangup(sid).catch(() => console.error('Could not cancel an existing call')); };
  const replies = new Map(Object.entries(router.state.mirroredReplies ?? {}));
  const saveReplies = () => { router.state.mirroredReplies = Object.fromEntries(replies); router.save(); };
  const activeTurns = new Map<string, string>();
  let typing = false;
  const updateTyping = () => {
    const active = [...replies.values()].some(reply => reply.finalText === undefined && reply.reaction !== 'final'
      && (reply.turnId || Date.now() - reply.receivedAt < 10_000));
    if (active || typing) claw.typing(active);
    typing = active;
  };
  function expectReply(id: string, message: { messageId: string; text: string }, turnId?: string) {
    const previous = replies.get(id);
    if (previous) flushFinal(id, previous);
    const reply = { messageId: message.messageId, text: message.text.trim(), receivedAt: Date.now(), turnId };
    replies.set(id, reply);
    saveReplies();
    updateTyping();
    return reply;
  }
  let inbox = Promise.resolve();
  let sessionSwitch = 0;
  async function sendFromSession(id: string, body: string) {
    const beforeSwitch = sessionSwitch;
    const sent = await claw.send(body);
    if (sessionSwitch === beforeSwitch) router.state.textSessionId = id;
    const messageId = sent?.messageId ?? sent?.message_id;
    if (typeof messageId === 'string') router.rememberStatusText(messageId, id);
    else router.save();
    return sent;
  }
  async function handleText(message: ClawMessage) {
    const input = message.text.trim();
    const menu = router.state.sessionMenu;
    const list = /^\/sessions?$/i.test(input);
    const start = /^\/sessions?\s+new$/i.test(input);
    if (router.state.handledMenuMessages?.includes(message.messageId)) return;
    const model = input.match(/^\/model(?:\s+([\s\S]+))?$/i);
    const effort = input.match(/^\/effort(?:\s+([\s\S]+))?$/i);
    const usage = /^\/usage$/i.test(input);
    if (model || effort || list || start || usage || (menu && /^(?:\d+|cancel)$/i.test(input))) {
      if (message.sentAt && !Number.isFinite(Date.parse(message.sentAt))) return;
      if (message.sentAt && Date.now() - Date.parse(message.sentAt) > 3600000) return;
      const remember = () => {
        router.state.handledMenuMessages = [...(router.state.handledMenuMessages ?? []).slice(-199), message.messageId];
        router.save();
      };
      if (usage) {
        remember();
        const limits = await codex.usage().catch(() => undefined);
        if (!limits) { await claw.send('I couldn’t read your Codex usage right now. Try /usage again in a moment.'); return; }
        const format = (percent: number | undefined) => percent === undefined ? 'unavailable' : `${percent}% used`;
        await claw.send(`Codex usage\n5-hour limit: ${format(limits.fiveHour)}\nWeekly limit: ${format(limits.weekly)}`);
      } else if (start) {
        // Claim the incoming message first. A timed-out create may have succeeded.
        remember();
        let choice;
        try { choice = await codex.startSession(router.textTarget()?.cwd || undefined); }
        catch { await claw.send('I couldn’t confirm the new session. Check /sessions before trying again.'); return; }
        router.select(choice);
        sessionSwitch++;
        await claw.send('New Codex session created and selected. Send your first message whenever you’re ready.');
      } else if (model || effort) {
        remember();
        const selected = router.textTarget();
        if (!selected || selected.ended) { await claw.send('Choose a session with /sessions first.'); return; }
        if (effort) {
          const level = (effort[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
          if (!Object.hasOwn(effortLevels, level)) {
            await claw.send('Use /effort followed by low, medium, high, extra high, or ultra.');
            return;
          }
          let applied: boolean;
          try { applied = await codex.setEffort(selected.id, effortLevels[level as keyof typeof effortLevels]); }
          catch { await claw.send('I couldn’t confirm the effort change. Check the effort setting in Codex.'); return; }
          await claw.send(applied ? `Effort set to ${level} for the next turn.` : `The selected model doesn’t support ${level} effort.`);
          return;
        }
        if (!model) return;
        if (!model[1]?.trim() || model[1].length > 100) { await claw.send('Send /model followed by the model name.'); return; }
        let name: string | null | undefined;
        try { name = await codex.setModel(selected.id, model[1]); }
        catch { await claw.send('I couldn’t confirm the model change. Check the model in Codex.'); return; }
        await claw.send(name ? `Model set to ${name} for the next turn.` : 'I couldn’t match that model name.');
      } else if (list) {
        if (!menu) {
          const available = await codex.sessions();
          if (!available.length) { await claw.send('No Codex sessions are available.'); return; }
          available.forEach(choice => router.rememberSession(choice));
          router.state.sessionMenu = available.map(choice => choice.id);
        }
        remember();
        const lines = router.state.sessionMenu!.map((id, index) => `${index + 1}. ${router.state.sessions[id]?.title ?? 'Unavailable session'}${router.textTarget()?.id === id ? ' (selected)' : ''}`);
        let page = '';
        for (const line of [...lines, '', 'Reply with a number to switch, or cancel.']) {
          if (page.length + line.length > 1700) { await claw.send(page.trim()); page = ''; }
          page += line + '\n';
        }
        await claw.send(page.trim());
      } else if (/^cancel$/i.test(input)) {
        router.state.sessionMenu = undefined;
        remember();
        await claw.send('Session selection canceled.');
      } else {
        const target = menu![Number(input) - 1];
        if (!target) { await claw.send('That number isn’t in the menu. Reply with a listed number or cancel.'); return; }
        const available = await codex.sessions();
        const choice = available.find(session => session.id === target);
        if (!choice) { await claw.send('That session is unavailable. Choose another number or cancel and reopen /sessions.'); return; }
        router.select(choice);
        sessionSwitch++;
        remember();
        await claw.send(`Switched to ${choice.title}.`);
      }
      return;
    }
    const e = router.textReply(message);
    if (!e) {
      const queued = router.followUp(message);
      if (queued) {
        const reply = expectReply(queued.sessionId, message);
        void deliver(queued.sessionId, queued.text, queued.id).then(async result => {
          if (result.delivered && result.turnId && replies.get(queued.sessionId) === reply) {
            reply.turnId = result.turnId;
            saveReplies();
          }
          console.info('[Claw] Follow-up', result.delivered ? 'accepted by Codex' : 'saved for a Codex hook');
          if (!result.delivered) await claw.send(result.message ?? 'Delivery is unconfirmed.');
        }).catch(() => console.error('[Claw] Follow-up delivery failed; message is queued'));
      } else if (!message.replyTo && (!router.textTarget() || router.textTarget()?.ended)
        && !router.state.instructions.some(item => item.id === `claw:${message.messageId}`)) {
        await claw.send('There’s no available session selected. Text /sessions to choose one.');
      }
      return;
    }
    if (e.kind === 'approval' && !/^(y|yes|n|no)$/i.test(e.reply!)) router.queue(e.sessionId, e.reply!, e.id);
    const turn = activeTurns.get(e.sessionId);
    if (e.kind === 'question' && turn) expectReply(e.sessionId, message, turn);
    if (e.callSid) void endCalls([e.callSid]);
    console.info('[Claw] Received reply & canceled SignalWire escalation');
  }
  const claw = new Messenger(c, message => {
    inbox = inbox.then(() => handleText(message)).catch(() => {
      console.warn('[Claw] Text routing failed');
      return claw.send('I couldn’t complete that session request. Try /sessions again.').then(() => {}, () => {});
    });
  }, reaction => {
    const event = Object.values(router.state.events).find(e => e.kind === 'approval' && e.clawMessageId === reaction.messageId);
    if (event && (reaction.reactionType === 'like' || reaction.reactionType === 'dislike') && (event.approvalCommand || event.textDecision)) {
      if (event.cancelled || event.acknowledged || event.reply !== null || event.reactionClaimed || Date.now() > event.dueAt) return;
      event.reactionClaimed = true;
      router.save();
      const allow = reaction.reactionType === 'like';
      void (async () => {
        if (event.approvalCommand && !await codex.decideApproval(event.sessionId, event.key, event.approvalCommand, allow)) {
          await claw.send('That approval could not be applied. Review it in Codex.');
          return;
        }
        if (!event.cancelled) router.reply(event.id, allow ? 'Yes' : 'No', allow ? 'allow' : 'deny');
        if (event.callSid) await endCalls([event.callSid]);
      })().catch(() => console.warn('[Claw] Approval reaction outcome unconfirmed'));
      return;
    }
    const queued = router.recordReaction(reaction);
    if (!queued) return;
    void deliver(queued.sessionId, queued.text, queued.id).then(result => {
      console.info('[Claw] Reaction', result.delivered ? 'accepted by Codex' : 'saved for a Codex hook');
    }).catch(() => console.error('[Claw] Reaction delivery failed; reaction is queued'));
  });
  app.post('/internal/status-text', async (req, res) => {
    const report = text.parse(req.body?.text);
    const result = await claw.send(`Quick project check-in\n${report}\n\nNo reply needed.`);
    const messageId = result?.messageId ?? result?.message_id;
    if (typeof messageId === 'string') router.rememberStatusText(messageId);
    res.json({ sent: true });
  });
  app.post('/internal/react', async (req, res) => {
    const { sessionId: id, cwd, message, reaction, keepReply } = z.object({
      sessionId, cwd: z.string().min(1).max(4096), message: z.string().trim().min(1).max(4000), reaction: z.enum(replyReactions).default('like'),
      keepReply: z.boolean().default(false),
    }).parse(req.body);
    const target = router.reactionTarget(id, cwd, message);
    if (!target) { res.json({ sent: false, reason: 'No unique recent incoming iMessage matches this chat and text' }); return; }
    if (!claw.connected) { res.json({ sent: false, reason: 'Claw is disconnected' }); return; }
    try {
      const sent = await claw.react(target, reaction);
      const pending = replies.get(id);
      if (sent && pending?.messageId === target) {
        pending.reaction = keepReply ? 'acknowledgment' : 'final';
        saveReplies();
        if (!keepReply) updateTyping();
      }
      res.json({ sent });
    }
    catch { res.json({ sent: false, uncertain: true, reason: 'Reaction delivery is unconfirmed. Do not retry automatically.' }); }
  });
  app.post('/internal/turn-text', (req, res) => {
    const { sessionId: id, turnId, final, prompt, clear } = z.object({
      sessionId, turnId: sessionId.optional(), final: z.string().max(60000).optional(),
      prompt: z.string().max(4000).optional(), clear: z.boolean().optional(),
    }).parse(req.body);
    if (turnId) activeTurns.set(id, turnId);
    const session = router.state.sessions[id];
    if (session && turnId && prompt && router.state.instructions.some(item => item.remote && item.sessionId === id
      && !item.delivered && item.uncertain && item.text === prompt.trim())) {
      session.remoteTurn = turnId;
      router.save();
    }
    if (clear) { activeTurns.delete(id); if (replies.delete(id)) { saveReplies(); updateTyping(); } }
    const reply = replies.get(id);
    if (reply && turnId) {
      if (prompt && reply.text === prompt.trim() && !reply.turnId) { reply.turnId = turnId; saveReplies(); }
      if (final !== undefined && reply.turnId === turnId && reply.finalText === undefined) {
        if (session) session.notifiedDoneTurn = turnId;
        if (reply.reaction !== 'final' && final.trim()) reply.finalText = final.trim();
        else replies.delete(id);
        saveReplies();
        updateTyping();
        flushFinal(id, reply);
      }
    } else if (turnId && final?.trim()) {
      if (session && session.remoteTurn !== turnId && session.notifiedDoneTurn !== turnId && session.pendingDoneTurn !== turnId) {
        session.pendingDoneTurn = turnId;
        router.save();
        flushDone(id);
      }
    }
    res.json({ ok: true });
  });
  function flushDone(id: string) {
    const session = router.state.sessions[id];
    if (!claw.connected || !session?.pendingDoneTurn) return;
    session.notifiedDoneTurn = session.pendingDoneTurn;
    session.pendingDoneTurn = undefined;
    router.save();
    void sendFromSession(id, 'Done').then(() => console.info('[Claw] Sent completion text'))
      .catch(() => console.warn('[Claw] Completion text delivery failed'));
  }
  function flushFinal(id: string, reply: MirroredReply) {
    if (!claw.connected || reply.finalText === undefined) return;
    // Claim before sending so a restart cannot send the same reply twice.
    replies.delete(id);
    saveReplies();
    void sendTurnReply(id, reply, reply.finalText).catch(() => console.warn('[Claw] Final iMessage reply failed'));
  }
  async function sendTurnReply(id: string, reply: { messageId: string; text: string; reaction?: 'acknowledgment' | 'final' }, final: string) {
    const answer = final.replace(/[.!]$/, '').trim().toLowerCase();
    const reactions = new Map<string, ReplyReaction>([['👍', 'like'], ['👎', 'dislike'], ['❤️', 'love'], ['❤', 'love']]);
    const question = reply.text.endsWith('?') || /^(is|are|was|were|do|does|did|can|could|will|would|has|have|should)\s/i.test(reply.text);
    let reaction = reactions.get(answer);
    if (!reaction && question && (answer === 'yes' || answer === 'no')) reaction = answer === 'yes' ? 'like' : 'dislike';
    if (!reaction && /^(great (work|job)|nice (work|job)|well done)[.!]?$/i.test(reply.text)
      && /^(thanks|thank you)[!.]?$/.test(answer)) reaction = 'love';
    if (reply.reaction !== 'acknowledgment' && reaction && await claw.react(reply.messageId, reaction).catch(() => false)) {
      console.info('[Claw] Sent reaction as final reply');
      return;
    }
    // Keep each message within the provider's text size and avoid splitting Unicode characters.
    for (const part of final.match(/[\s\S]{1,1800}/gu) ?? []) {
      await sendFromSession(id, part);
    }
    console.info('[Claw] Sent Codex final reply');
  }
  app.post('/internal/activity', async (req, res) => {
    const a = activityInput.parse(req.body);
    router.touch(a.sessionId, a.cwd, a.summary, a.ended, a.transcript ? rolloutPath(a.transcript, a.sessionId) : undefined);
    if (a.cancel || a.ended) await endCalls(router.cancel(a.sessionId));
    res.json({ ok: true });
  });
  const approvalChecks = new Map<string, number>();
  app.post('/internal/watch-approval', (req, res) => {
    const id = sessionId.parse(req.body?.sessionId);
    if (router.state.sessions[id] && !router.state.sessions[id].ended) approvalChecks.set(id, Date.now() + 45_000);
    res.json({ ok: true });
  });
  function createEvent(a: z.infer<typeof eventInput>, approvalCommand?: string) {
    const nativeApproval = a.kind === 'approval' && a.key.startsWith('desktop-approval:');
    const oldCalls = nativeApproval ? [] : Object.values(router.state.events)
      .filter(e => e.sessionId === a.sessionId && e.key !== a.key && !e.cancelled && e.callSid).map(e => e.callSid!);
    const result = router.create(a.sessionId, a.key, a.question, a.kind, c.ESCALATION_TIMEOUT_SECONDS);
    if (result.fresh) {
      if (a.kind === 'approval') {
        result.event.textDecision = a.textDecision === true;
        result.event.approvalCommand = approvalCommand;
        router.save();
      }
      void endCalls(oldCalls);
      if (c.CLAW_API_KEY) {
        const e = result.event;
        const alert = e.kind === 'approval' ? 'Quick approval check' : 'Hey, I could use your help.';
        const options = e.kind === 'approval'
          ? e.approvalCommand ? 'React 👍 to approve once or 👎 to deny.' : 'Review it in Codex.'
          : 'Just text me back when you can.';
        const summary = e.kind === 'approval' ? e.question : e.question.slice(0, 1500);
        void sendFromSession(e.sessionId, `${alert}\n${summary}\n\n${options}`).then(result => {
          const id = result?.messageId ?? result?.message_id;
          if (typeof id === 'string') e.clawMessageId = id;
          e.clawSentAt = Date.now();
          router.save();
          console.info('[Claw] Sent iMessage alert');
        }).catch(() => { e.error = 'iMessage send failed; SignalWire fallback remains scheduled'; router.save(); });
      }
    }
    return { id: result.event.id, dueAt: result.event.dueAt, textEnabled: Boolean(c.CLAW_API_KEY) };
  }
  app.post('/internal/events', (req, res) => {
    res.json(createEvent(eventInput.parse(req.body)));
  });
  app.get('/internal/events/:id', (req, res) => {
    const e = router.state.events[req.params.id];
    if (!e) { res.sendStatus(404); return; }
    res.json({ id: e.id, reply: e.reply, decision: e.decision, cancelled: e.cancelled, acknowledged: e.acknowledged, error: e.error });
  });
  app.post('/internal/cancel', async (req, res) => { const { sessionId: id } = z.object({ sessionId }).parse(req.body); await endCalls(router.cancel(id)); res.json({ ok: true }); });
  app.post('/internal/instructions', (req, res) => {
    const a = z.object({ sessionId, deliveredIds: z.array(z.string()).max(100).optional(), turnId: sessionId.optional() }).parse(req.body);
    if (a.deliveredIds) router.delivered(a.sessionId, a.deliveredIds);
    const reply = replies.get(a.sessionId);
    if (reply && a.turnId && a.deliveredIds?.includes(`claw:${reply.messageId}`)) { reply.turnId = a.turnId; saveReplies(); }
    res.json({ instructions: router.pending(a.sessionId) });
  });
  app.get('/internal/status', (_req, res) => res.json({ sessions: Object.values(router.state.sessions), active: router.selected() ?? null }));

  const ackEvent = (id: string, token: unknown) => {
    const e = router.state.events[id];
    return e && typeof token === 'string' && equalSecret(token, e.ackToken) && Date.now() - e.createdAt < 86400000 ? e : undefined;
  };
  app.get('/ack/:id', (req, res) => {
    const e = ackEvent(req.params.id, req.query.token);
    if (!e) { res.sendStatus(403); return; }
    // GET only renders: preview crawlers must not acknowledge notifications.
    res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex notification</title><style>body{font:20px system-ui;max-width:32rem;margin:3rem auto;padding:1rem}button{font:inherit;padding:1rem;border-radius:.5rem}</style><h1>Codex notification</h1><p>Stop the escalation call for this notification.</p><form method="post" action="/ack/${e.id}"><input type="hidden" name="token" value="${e.ackToken}"><button>Acknowledge — don’t call</button></form></html>`);
  });
  app.post('/ack/:id', async (req, res) => {
    const e = ackEvent(req.params.id, req.body.token);
    if (!e) { res.sendStatus(403); return; }
    router.ack(e.id);
    if (e.callSid) await endCalls([e.callSid]);
    res.type('html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acknowledged</title><h1>Acknowledged</h1><p>The escalation call has been cancelled. You can close this page.</p></html>');
  });

  const grants = new Map<string, VoiceContext & { expires: number }>();
  const usedCalls = new Set<string>();
  const base = c.PUBLIC_WEBHOOK_URL.replace(/\/$/, '');
  const signedVoiceRequest = (req: express.Request) => {
    const signature = req.get('x-signalwire-signature') ?? '';
    return !!signature && !!req.is('application/x-www-form-urlencoded') && !!req.body && validSignature(c, signature, req.originalUrl, req.body);
  };
  app.post('/voice/stream-status', (req, res) => {
    if (!signedVoiceRequest(req)) { res.sendStatus(403); return; }
    const event = req.body.StreamEvent;
    if (['stream-started', 'stream-stopped', 'stream-error'].includes(event)) {
      const code = String(req.body.StreamError ?? '').split(':')[0];
      console.info('SignalWire media status:', event, /^[a-z_]{1,60}$/.test(code) ? code : '');
    }
    res.sendStatus(204);
  });
  app.post(['/voice/inbound', '/voice/outbound'], (req, res) => {
    if (!signedVoiceRequest(req)) {
      console.warn('SignalWire voice request rejected: invalid signature or form');
      res.sendStatus(403); return;
    }
    res.type('xml');
    const reject = () => { console.warn('SignalWire voice request rejected: call did not match an eligible bridge session'); res.send('<Response><Reject /></Response>'); };
    if (req.body.AccountSid !== c.SIGNALWIRE_PROJECT_ID || typeof req.body.CallSid !== 'string') { reject(); return; }
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : undefined;
    const e = eventId ? router.state.events[eventId] : undefined;
    const outbound = req.path === '/voice/outbound';
    if (outbound) {
      if (req.body.To !== c.USER_PHONE_NUMBER || req.body.From !== c.SIGNALWIRE_PHONE_NUMBER || !e || e.kind === 'stop' || !e.callAttempted || e.cancelled || e.acknowledged || e.reply !== null || (e.callSid && e.callSid !== req.body.CallSid)) { reject(); return; }
      e.callSid = req.body.CallSid; router.save();
    } else if (req.body.From !== c.USER_PHONE_NUMBER || req.body.To !== c.SIGNALWIRE_PHONE_NUMBER || eventId) { reject(); return; }
    const selected = outbound ? router.state.sessions[e!.sessionId] : router.selected();
    if (outbound && (!selected || selected.ended)) { res.send('<Response><Say>The session that requested this call is unavailable.</Say><Hangup /></Response>'); return; }
    if (usedCalls.has(req.body.CallSid)) { reject(); return; }
    if (usedCalls.size > 10000) { res.send('<Response><Say>Bridge maintenance required.</Say><Hangup /></Response>'); return; }
    usedCalls.add(req.body.CallSid);
    const token = randomBytes(32).toString('hex');
    grants.set(token, { callSid: req.body.CallSid, sessionId: selected?.id ?? '', eventId: e?.id, question: e?.question, approval: e?.kind === 'approval', expires: Date.now() + 60000 });
    console.info('SignalWire voice webhook accepted:', outbound ? 'outbound' : 'inbound');
    // SignalWire's live upgrade didn't carry a usable Authorization header.
    res.send(`<Response><Connect><Stream url="${xml(base.replace(/^https:/, 'wss:') + '/media-stream/' + token)}" codec="PCMU@8000h" statusCallback="${xml(base + '/voice/stream-status')}" /></Connect><Hangup /></Response>`);
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err instanceof z.ZodError ? 'Rejected invalid bridge request' : 'Bridge request failed');
    res.status(err instanceof z.ZodError ? 400 : 500).json({ error: 'Request could not be processed' });
  });
  const server = createServer(app);
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  async function deliver(id: string, message: string, instructionId: string, allowHookFallback = true) {
    const queued = router.queue(id, message, instructionId);
    if (queued.delivered) return { delivered: true };
    // Keep hooks from consuming the same instruction during direct submission.
    queued.uncertain = true;
    queued.remote = true;
    router.save();
    try {
      const result = await codex.deliverText(id, message, instructionId);
      const session = router.state.sessions[id];
      if (session && result.turnId) session.remoteTurn = result.turnId;
      router.delivered(id, [instructionId]);
      return { delivered: true, turnId: result.turnId };
    } catch (error) {
      // shortcut: ambiguous transport failures require manual review; don't auto-retry a possibly accepted turn.
      const uncertain = !(error instanceof DeliveryError) || error.uncertain;
      if (!allowHookFallback && !uncertain) {
        router.state.instructions = router.state.instructions.filter(item => item !== queued);
        router.save();
        return { delivered: false, message: 'The chat did not receive it. Tell the caller direct delivery failed and ask them to try again.' };
      }
      queued.uncertain = uncertain; router.save();
      if (!allowHookFallback) return { delivered: false, uncertain: true,
        message: 'Direct delivery is unconfirmed. Tell the caller to check the chat before repeating the instruction.' };
      return { delivered: false, queued: true, message: queued.uncertain
        ? 'Saved locally. Delivery to Codex is unconfirmed; check the chat before retrying.'
        : 'Queued for the next Codex lifecycle hook or MCP poll. The chat has not received it yet.' };
    }
  }
  server.on('upgrade', (req, socket, head) => {
    const token = req.url?.match(/^\/media-stream\/([a-f0-9]{64})$/)?.[1];
    const grant = token ? grants.get(token) : undefined;
    if (!token || !grant || grant.expires < Date.now()) { console.warn('SignalWire media upgrade rejected: invalid or expired grant'); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    grants.delete(token);
    console.info('SignalWire media upgrade accepted');
    let callSessionId = grant.sessionId;
    ws.handleUpgrade(req, socket, head, phone => bridgeVoice(phone, c, grant, {
      usage: async () => {
        const limits = await codex.usage();
        const remaining = (used?: number) => used === undefined ? null : Math.max(0, Number((100 - used).toFixed(2)));
        return { fiveHourPercentLeft: remaining(limits.fiveHour), weeklyPercentLeft: remaining(limits.weekly) };
      },
      changeSettings: async ({ model, effort }) => {
        const id = callSessionId;
        if (!router.state.sessions[id] || router.state.sessions[id].ended) {
          return { error: 'Choose an available Codex session first.' };
        }
        const value = effort ? effortLevels[effort] : undefined;
        if (model) {
          const name = await codex.setModel(id, model, value);
          if (name === null) return { error: 'That model does not support the requested effort. No settings changed.' };
          if (!name) return { error: 'No unique model matched. Ask the caller for the model family and version.' };
          return { model: name, effort, applies: 'next turn' };
        }
        if (!value || !await codex.setEffort(id, value)) return { error: 'The current model does not support that effort.' };
        return { effort, applies: 'next turn' };
      },
      sessions: async () => (await codex.sessions()).map(({id, title, cwd}) => ({ id, title, workspace: cwd, selected: id === callSessionId })),
      switchSession: async (query, id, workspace) => {
        const sessions = await codex.sessions();
        const needle = query.trim().toLowerCase();
        const candidates = workspace ? sessions.filter(s => s.cwd === workspace) : sessions;
        const exact = candidates.filter(s => s.title.toLowerCase() === needle);
        const matching = exact.length ? exact : candidates.filter(s => s.title.toLowerCase().includes(needle));
        if (matching.length !== 1 || matching[0].id !== id) return { switched: false, message: 'Ask which session the caller means.', matches: matching.map(s => s.title) };
        const choice = matching[0];
        if (router.state.sessions[id]?.ended) return { switched: false, message: 'That session is unavailable.' };
        router.rememberSession(choice);
        router.save();
        callSessionId = id;
        return { switched: true, title: choice.title };
      },
      status: async () => {
        const saved = router.state.sessions[callSessionId];
        if (!saved || saved.ended) return { error: 'No available session selected. Ask the caller to choose one.' };
        const live = await codex.status(callSessionId).catch(() => null);
        return { chat: live?.name ?? saved.title ?? callSessionId, workspace: saved.cwd, summary: saved.summary,
          liveStatus: live?.status ?? 'unavailable', pendingQuestion: callSessionId === grant.sessionId ? grant.question : undefined };
      },
      submit: async reply => {
        if (callSessionId !== grant.sessionId) return { saved: false, error: 'Switch back to the original session to answer its question.' };
        router.reply(grant.eventId!, reply);
        return { saved: true, delivery: 'The waiting MCP tool or lifecycle hook will receive this reply.' };
      },
      queue: (message, id) => !callSessionId || router.state.sessions[callSessionId]?.ended
        ? Promise.resolve({ delivered: false, message: 'Choose an available session before sending an instruction.' })
        : deliver(callSessionId, message, id, false),
      hangup: () => providers.hangup(grant.callSid),
    }));
  });
  let ticking = false, lastDial = 0, lastApprovalCheck = 0, lastTyping = 0;
  let lastUsageCheck = 0;
  async function checkUsageLimits() {
    if (!claw.connected || Date.now() - lastUsageCheck < 10_000) return;
    lastUsageCheck = Date.now();
    for (const session of Object.values(router.state.sessions)) {
      if (session.ended || !session.transcript || Date.now() - session.updatedAt > 24 * 60 * 60_000) continue;
      const file = rolloutPath(session.transcript, session.id);
      if (!file) continue;
      const turn = await latestUsageLimit(file, startedAt).catch(() => undefined);
      if (!turn || router.state.sessions[session.id]?.alertedUsageTurn === turn) continue;
      router.state.sessions[session.id].alertedUsageTurn = turn;
      router.save();
      await sendFromSession(session.id, 'Codex hit its usage limit while working on a task. That task is paused.')
        .catch(() => console.warn('[Claw] Usage limit alert delivery failed'));
    }
  }
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const [token, g] of grants) if (g.expires < Date.now()) grants.delete(token);
      if (Date.now() - lastTyping >= 4000) {
        lastTyping = Date.now();
        for (const [id, reply] of replies) {
          if (Date.now() - reply.receivedAt > 3600000) { replies.delete(id); saveReplies(); }
          else flushFinal(id, reply);
        }
        updateTyping();
        for (const id of Object.keys(router.state.sessions)) flushDone(id);
      }
      if (approvalChecks.size && Date.now() - lastApprovalCheck >= 3000) {
        lastApprovalCheck = Date.now();
        await Promise.all([...approvalChecks].map(async ([id, expiry]) => {
          if (Date.now() >= expiry || router.state.sessions[id]?.ended) { approvalChecks.delete(id); return; }
          const keys = await codex.approvals(id);
          if (!keys?.length || router.state.sessions[id]?.ended) return;
          for (const key of keys) {
            if (Object.values(router.state.events).some(e => e.sessionId === id && e.key === key)) continue;
            const command = await codex.approvalDetails(id, key);
            if (router.state.sessions[id]?.ended) return;
            createEvent({ sessionId: id, key, kind: 'approval', question: command ?? 'Codex is waiting for your approval.' }, command);
          }
        }));
      }
      for (const e of router.due()) {
        if (Date.now() - e.createdAt > 3600000) { e.cancelled = true; router.save(); continue; }
        if (Date.now() - lastDial < 60000) break;
        if (e.kind === 'approval' && e.key.startsWith('desktop-approval:')) {
          const keys = await codex.approvals(e.sessionId);
          if (!keys?.includes(e.key)) { e.cancelled = true; router.save(); continue; }
        }
        if (!router.claim(e.id)) continue;
        lastDial = Date.now();
        console.info('[Escalation] Timeout reached, placing SignalWire call');
        try {
          const call = await providers.dial(e);
          e.callSid = call.sid; router.save();
          if (e.cancelled || e.acknowledged || e.reply !== null) await endCalls([call.sid]);
        } catch { e.error = 'Call failed or its outcome is uncertain; no automatic retry'; router.save(); }
      }
    } finally { ticking = false; }
    void checkUsageLimits().catch(() => console.warn('[Claw] Could not check Codex usage limits'));
  };
  return { server, tick, startText: () => claw.start(), close: () => {
    if (typing) claw.typing(false);
    claw.stop();
    ws.clients.forEach(client => client.terminate()); ws.close(); server.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const c = serverConfig();
  const bridge = createBridge(c, new Router(resolve(projectRoot, 'data/state.json')));
  bridge.startText();
  bridge.server.listen(c.PORT, '127.0.0.1', () => console.log(`Voice bridge listening on 127.0.0.1:${c.PORT}`));
  const timer = setInterval(() => void bridge.tick().catch(() => console.error('Escalation scheduler failed')), 1000);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { clearInterval(timer); bridge.close(); });
}
