import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { serverConfig, projectRoot, type Config } from './config.js';
import { Router, type BridgeEvent } from './session-router.js';
import { Providers, equalSecret, validSignature, xml } from './providers.js';
import { CodexClient, DeliveryError } from './codex-client.js';
import { bridgeVoice, type VoiceContext } from './voice-session.js';
import { Claw, replyReactions, type ReplyReaction } from './claw.js';

const sessionId = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
const eventInput = z.object({ sessionId, key: z.string().min(1).max(500), question: text, kind: z.enum(['question', 'approval']), textDecision: z.boolean().optional() });
const activityInput = z.object({ sessionId, cwd: z.string().max(4096), summary: z.string().max(4000).optional(), ended: z.boolean().optional(), cancel: z.boolean().optional() });

export function createBridge(c: Config, router: Router, providers = new Providers(c), codex = new CodexClient(), Messenger = Claw) {
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
  const replies = new Map<string, { messageId: string; text: string; receivedAt: number; turnId?: string; reacted?: boolean }>();
  const activeTurns = new Map<string, string>();
  let typing = false;
  const updateTyping = () => {
    const active = [...replies.values()].some(reply => !reply.reacted && (reply.turnId || Date.now() - reply.receivedAt < 10_000));
    if (active || typing) claw.typing(active);
    typing = active;
  };
  function expectReply(id: string, message: { messageId: string; text: string }, turnId?: string) {
    const reply = { messageId: message.messageId, text: message.text.trim(), receivedAt: Date.now(), turnId };
    replies.set(id, reply);
    updateTyping();
    return reply;
  }
  const claw = new Messenger(c, message => {
    const e = router.textReply(message);
    if (!e) {
      const queued = router.followUp(message);
      if (queued) {
        const reply = expectReply(queued.sessionId, message);
        void deliver(queued.sessionId, queued.text, queued.id, true).then(result => {
          if (result.delivered && result.turnId) reply.turnId = result.turnId;
          console.info('[Claw] Follow-up', result.delivered ? 'accepted by Codex' : 'saved for a Codex hook');
        }).catch(() => console.error('[Claw] Follow-up delivery failed; message is queued'));
      }
      return;
    }
    if (e.kind === 'approval' && !/^(y|yes|n|no)$/i.test(e.reply!)) router.queue(e.sessionId, e.reply!, e.id);
    const turn = activeTurns.get(e.sessionId);
    if (e.kind === 'question' && turn) expectReply(e.sessionId, message, turn);
    if (e.callSid) void endCalls([e.callSid]);
    console.info('[Claw] Received reply & canceled SignalWire escalation');
  }, reaction => {
    const queued = router.recordReaction(reaction);
    if (!queued) return;
    void deliver(queued.sessionId, queued.text, queued.id, true).then(result => {
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
    const { sessionId: id, cwd, message, reaction } = z.object({
      sessionId, cwd: z.string().min(1).max(4096), message: z.string().trim().min(1).max(4000), reaction: z.enum(replyReactions).default('like'),
    }).parse(req.body);
    const target = router.reactionTarget(id, cwd, message);
    if (!target) { res.json({ sent: false, reason: 'No unique recent incoming iMessage matches this chat and text' }); return; }
    if (!claw.connected) { res.json({ sent: false, reason: 'Claw is disconnected' }); return; }
    try {
      const sent = await claw.react(target, reaction);
      const pending = replies.get(id);
      if (sent && pending?.messageId === target) { pending.reacted = true; updateTyping(); }
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
    if (clear) { activeTurns.delete(id); if (replies.delete(id)) updateTyping(); }
    const reply = replies.get(id);
    if (reply && turnId) {
      if (prompt && reply.text === prompt.trim()) reply.turnId = turnId;
      if (final !== undefined && reply.turnId === turnId) {
        replies.delete(id);
        updateTyping();
        if (!reply.reacted && final.trim()) void sendTurnReply(id, reply, final.trim()).catch(() => console.warn('[Claw] Final iMessage reply failed'));
      }
    }
    res.json({ ok: true });
  });
  async function sendTurnReply(id: string, reply: { messageId: string; text: string }, final: string) {
    const answer = final.replace(/[.!]$/, '').trim().toLowerCase();
    const reactions = new Map<string, ReplyReaction>([['👍', 'like'], ['👎', 'dislike'], ['❤️', 'love'], ['❤', 'love']]);
    const question = reply.text.endsWith('?') || /^(is|are|was|were|do|does|did|can|could|will|would|has|have|should)\s/i.test(reply.text);
    let reaction = reactions.get(answer);
    if (!reaction && question && (answer === 'yes' || answer === 'no')) reaction = answer === 'yes' ? 'like' : 'dislike';
    if (!reaction && /^(great (work|job)|nice (work|job)|well done)[.!]?$/i.test(reply.text)
      && /^(thanks|thank you)[!.]?$/.test(answer)) reaction = 'love';
    if (reaction && await claw.react(reply.messageId, reaction).catch(() => false)) {
      console.info('[Claw] Sent reaction as final reply');
      return;
    }
    // Keep each message within the provider's text size and avoid splitting Unicode characters.
    for (const part of final.match(/[\s\S]{1,1800}/gu) ?? []) {
      const sent = await claw.send(part);
      const messageId = sent?.messageId ?? sent?.message_id;
      if (typeof messageId === 'string') router.rememberStatusText(messageId, id);
    }
    console.info('[Claw] Sent Codex final reply');
  }
  app.post('/internal/activity', async (req, res) => {
    const a = activityInput.parse(req.body);
    router.touch(a.sessionId, a.cwd, a.summary, a.ended);
    if (a.cancel || a.ended) await endCalls(router.cancel(a.sessionId));
    res.json({ ok: true });
  });
  const approvalChecks = new Map<string, number>();
  app.post('/internal/watch-approval', (req, res) => {
    const id = sessionId.parse(req.body?.sessionId);
    if (router.state.sessions[id] && !router.state.sessions[id].ended) approvalChecks.set(id, Date.now() + 45_000);
    res.json({ ok: true });
  });
  function createEvent(a: z.infer<typeof eventInput>) {
    const oldCalls = Object.values(router.state.events).filter(e => e.sessionId === a.sessionId && e.key !== a.key && !e.cancelled && e.callSid).map(e => e.callSid!);
    const result = router.create(a.sessionId, a.key, a.question, a.kind, c.ESCALATION_TIMEOUT_SECONDS);
    if (result.fresh) {
      if (a.kind === 'approval') {
        result.event.textDecision = a.textDecision === true;
        for (const older of Object.values(router.state.events)) {
          if (older.id === result.event.id || older.kind !== 'approval' || older.cancelled || older.reply !== null) continue;
          older.cancelled = true;
          if (older.callSid) oldCalls.push(older.callSid);
        }
        router.save();
      }
      void endCalls(oldCalls);
      if (c.CLAW_API_KEY) {
        const e = result.event;
        const alert = e.kind === 'approval' ? 'Quick approval check' : 'Hey, I could use your help.';
        const options = e.kind === 'approval' ? 'Review it in Codex.' : 'Just text me back when you can.';
        const summary = e.kind === 'approval' ? e.question : e.question.slice(0, 1500);
        void claw.send(`${alert}\n${summary}\n\n${options}`).then(result => {
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
    if (reply && a.turnId && a.deliveredIds?.includes(`claw:${reply.messageId}`)) reply.turnId = a.turnId;
    res.json({ instructions: router.pending(a.sessionId) });
  });
  app.get('/internal/status', (_req, res) => res.json({ sessions: Object.values(router.state.sessions), active: router.active() ?? null }));

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
    const selected = outbound ? router.state.sessions[e!.sessionId] : router.active();
    if (!selected || selected.ended) { res.send('<Response><Say>No active Codex session is registered.</Say><Hangup /></Response>'); return; }
    if (usedCalls.has(req.body.CallSid)) { reject(); return; }
    if (usedCalls.size > 10000) { res.send('<Response><Say>Bridge maintenance required.</Say><Hangup /></Response>'); return; }
    usedCalls.add(req.body.CallSid);
    const token = randomBytes(32).toString('hex');
    grants.set(token, { callSid: req.body.CallSid, sessionId: selected.id, eventId: e?.id, question: e?.question, approval: e?.kind === 'approval', expires: Date.now() + 60000 });
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
  async function deliver(id: string, message: string, instructionId: string, fromText = false) {
    const queued = router.queue(id, message, instructionId);
    if (queued.delivered) return { delivered: true };
    // Keep hooks from consuming the same instruction during direct submission.
    queued.uncertain = true;
    router.save();
    try {
      const result = fromText ? await codex.deliverText(id, message, instructionId) : await codex.deliver(id, message, instructionId);
      router.delivered(id, [instructionId]);
      return { delivered: true, turnId: result.turnId };
    } catch (error) {
      // shortcut: ambiguous transport failures require manual review; don't auto-retry a possibly accepted turn.
      queued.uncertain = !(error instanceof DeliveryError) || error.uncertain; router.save();
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
    ws.handleUpgrade(req, socket, head, phone => bridgeVoice(phone, c, grant, {
      status: async () => {
        const saved = router.state.sessions[grant.sessionId];
        const live = await codex.status(grant.sessionId).catch(() => null);
        return { chat: live?.name ?? grant.sessionId, workspace: saved?.cwd, summary: saved?.summary, liveStatus: live?.status ?? 'unavailable', pendingQuestion: grant.question };
      },
      submit: async reply => {
        router.reply(grant.eventId!, reply);
        return { saved: true, delivery: 'The waiting MCP tool or lifecycle hook will receive this reply.' };
      },
      queue: (message, id) => deliver(grant.sessionId, message, id),
      hangup: () => providers.hangup(grant.callSid),
    }));
  });
  let ticking = false, lastDial = 0, lastApprovalCheck = 0, lastTyping = 0;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const [token, g] of grants) if (g.expires < Date.now()) grants.delete(token);
      if (replies.size && Date.now() - lastTyping >= 4000) {
        lastTyping = Date.now();
        for (const [id, reply] of replies) if (Date.now() - reply.receivedAt > 3600000) replies.delete(id);
        updateTyping();
      }
      if (approvalChecks.size && Date.now() - lastApprovalCheck >= 3000) {
        lastApprovalCheck = Date.now();
        await Promise.all([...approvalChecks].map(async ([id, expiry]) => {
          if (Date.now() >= expiry || router.state.sessions[id]?.ended) { approvalChecks.delete(id); return; }
          const keys = await codex.approvals(id);
          if (!keys?.length || router.state.sessions[id]?.ended) return;
          const key = keys.find(key => !Object.values(router.state.events).some(e => e.sessionId === id && e.key === key));
          if (key) createEvent({ sessionId: id, key, kind: 'approval', question: 'Codex is waiting for your approval.' });
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
  };
  return { server, tick, startText: () => claw.start(), close: () => {
    replies.clear(); updateTyping(); claw.stop();
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
