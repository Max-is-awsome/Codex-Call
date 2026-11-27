import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { Router } from '../src/session-router.js';
import { createBridge } from '../src/server.js';
import { Providers, validSignature } from '../src/providers.js';
import { projectRoot, type Config } from '../src/config.js';
import { handleHook } from '../src/escalate-hook.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isPlaybackEcho, streamSpeech } from '../src/voice-session.js';
import { Claw, parseClawMessage, parseClawReaction, type ClawMessage } from '../src/claw.js';
import { CodexClient } from '../src/codex-client.js';

const config: Config = {
  SIGNALWIRE_SPACE_URL: 'https://example.signalwire.com', SIGNALWIRE_PROJECT_ID: '00000000-0000-4000-8000-000000000001',
  SIGNALWIRE_API_TOKEN: 'test-token-not-real', SIGNALWIRE_SIGNING_KEY: 'test-signing-key',
  SIGNALWIRE_PHONE_NUMBER: '+12025550101', USER_PHONE_NUMBER: '+12025550102',
  OPENAI_API_KEY: 'test-not-a-key', OPENAI_REALTIME_MODEL: 'gpt-realtime', PUBLIC_WEBHOOK_URL: 'https://bridge.example.com',
  BRIDGE_TOKEN: 'a'.repeat(64), ELEVENLABS_VOICE_ID: 'test-voice', PORT: 3456, ESCALATION_TIMEOUT_SECONDS: 60, CODEX_BIN: 'codex',
};
function tempRouter() { const dir = mkdtempSync(join(tmpdir(), 'voice-test-')); return { dir, router: new Router(join(dir, 'state.json')) }; }

test('iMessages steer a running desktop chat or start an idle one', async () => {
  const dir = mkdtempSync(join('/tmp', 'voice-ipc-'));
  const path = join(dir, 'ipc.sock');
  const requests: any[] = [];
  let idle = false;
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const end = 4 + buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, end).toString());
        buffer = buffer.subarray(end);
        requests.push(request);
        const ended = idle && request.method === 'thread-follower-steer-turn';
        const response = Buffer.from(JSON.stringify({
          type: 'response', requestId: request.requestId, resultType: ended ? 'error' : 'success',
          error: ended ? 'Cannot steer conversation target because its active turn already ended' : undefined,
          result: { clientId: 'bridge', result: request.method === 'thread-follower-start-turn' ? { turn: { id: 'idle-turn' } } : { turnId: 'active-turn' } }, handledByClientId: 'desktop',
        }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(response.length);
        socket.write(header);
        socket.write(response);
      }
    });
  });
  try {
    await once(server.listen(path), 'listening');
    const client = new CodexClient('/unused', path);
    assert.deepEqual(await client.deliverText('target', 'Hello from Messages', 'active-event'), { turnId: 'active-turn' });
    assert.deepEqual(requests.map(r => r.method), ['initialize', 'thread-owner-discovery', 'thread-follower-steer-turn']);
    assert.equal(requests.at(-1).params.clientUserMessageId, 'active-event');
    idle = true;
    assert.deepEqual(await client.deliverText('target', 'Hello again', 'idle-event'), { turnId: 'idle-turn' });
    const start = requests.at(-1);
    assert.equal(start.method, 'thread-follower-start-turn');
    assert.equal(start.version, 2);
    assert.equal(start.targetClientId, 'desktop');
    assert.deepEqual(start.params.turnStart.request, {
      threadId: 'target', clientUserMessageId: 'idle-event', input: [{ type: 'text', text: 'Hello again', text_elements: [] }],
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('thumbs-up and heart go to the original chat without deciding an approval', () => {
  const { dir, router } = tempRouter();
  try {
    router.touch('original', '/original');
    const alert = router.create('original', 'permission', 'Approve?', 'approval', 60).event;
    alert.clawMessageId = 'sent-message';
    router.touch('latest', '/latest');
    const frame = { type: 'reaction', reactionType: 'like', messageId: 'sent-message', from: config.USER_PHONE_NUMBER, added: true };
    assert.equal(parseClawReaction({...frame, added: false}, config.USER_PHONE_NUMBER), undefined);
    assert.equal(parseClawReaction({...frame, from: '+12025550199'}, config.USER_PHONE_NUMBER), undefined);
    assert.match(router.recordReaction(parseClawReaction(frame, config.USER_PHONE_NUMBER)!)!.text, /^Okay/);
    assert.equal(router.recordReaction(parseClawReaction(frame, config.USER_PHONE_NUMBER)!), undefined);
    assert.match(router.recordReaction(parseClawReaction({...frame, reactionType: 'love'}, config.USER_PHONE_NUMBER)!)!.text, /hearted/);
    assert.equal(router.pending('original').length, 2);
    assert.equal(router.pending('latest').length, 0);
    assert.equal(alert.decision, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary iMessage follow-ups are queued with no open question and deduplicated', () => {
  const { dir, router } = tempRouter();
  try {
    router.touch('chat', '/workspace');
    const message = { text: 'Can you check the latest build?', messageId: 'follow-up-1' };
    assert.equal(router.textReply(message), undefined);
    assert.equal(router.followUp(message)?.sessionId, 'chat');
    assert.equal(router.followUp(message), undefined);
    assert.equal(router.followUp({ text: 'yes', messageId: 'stale-approval' }), undefined);
    assert.deepEqual(router.pending('chat').map(i => i.text), [message.text]);
    assert.equal(router.reactionTarget('chat', '/workspace', message.text), 'follow-up-1');
    assert.equal(router.reactionTarget('chat', '/other', message.text), undefined);
    router.followUp({ ...message, messageId: 'same-text' });
    assert.equal(router.reactionTarget('chat', '/workspace', message.text), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an explicit thumbs-up waits for the matching Claw result', async () => {
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      const { id, ...reaction } = JSON.parse(payload);
      assert.deepEqual(reaction, { type: 'reaction', messageId: 'target', reactionType: 'like', remove: false });
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'reaction.result', id: 'unrelated', ok: false })));
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'reaction.result', id, ok: true })));
    },
  });
  const claw = new Claw(config, () => {});
  Object.assign(claw, { socket });
  assert.equal(await claw.react('target', 'like'), true);
  assert.equal(socket.listenerCount('message'), 0);
});

test('echoed notifications are rejected while short answers remain valid', () => {
  const notification = 'I built the fix for speech cutting out. Please save your Fish Audio key.';
  assert.ok(isPlaybackEcho('I built the fix for speech cutting out!', notification));
  assert.ok(isPlaybackEcho(`Codex said: ${notification}`, notification));
  assert.equal(isPlaybackEcho('Fish Audio key saved', notification), false);
  assert.equal(isPlaybackEcho('Yes', notification), false);
});

test('Fish audio requests 8 kHz PCM and converts samples split across chunks to PCMU', async () => {
  const frames: string[] = [];
  const voice = '33f31ddfa74249a683ead2792088622d';
  await streamSpeech({ ...config, FISH_AUDIO_API_KEY: 'fake-fish-key', FISH_AUDIO_VOICE_ID: voice }, 'Hello', new AbortController().signal, frame => frames.push(frame), async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fake-fish-key');
    assert.deepEqual(JSON.parse(String(options?.body)), { text: 'Hello', reference_id: voice, format: 'pcm', sample_rate: 8000, latency: 'low' });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Uint8Array.of(0));
      controller.enqueue(Uint8Array.of(0, 255, 127, 0));
      controller.enqueue(Uint8Array.of(128));
      controller.close();
    } }));
  });
  assert.deepEqual([...Buffer.concat(frames.map(frame => Buffer.from(frame, 'base64')))], [255, 128, 0]);
});

test('Claw replies require the allowed sender and exact pending request, and suppress dialing', () => {
  const { dir, router } = tempRouter();
  try {
    router.touch('chat', '/workspace');
    const old = router.create('chat', 'old', 'Old request', 'approval', 60).event;
    const current = router.create('chat', 'new', 'New request', 'approval', 60).event;
    current.textDecision = true;
    const base = {type: 'message', from: config.USER_PHONE_NUMBER, service: 'iMessage', messageId: 'reply1'};
    const reply = {...base, text: `${current.id.slice(0, 8)} YES`};
    assert.equal(parseClawMessage({...reply, fromMe: true}, config.USER_PHONE_NUMBER), undefined);
    assert.equal(parseClawMessage({...reply, from: '+12025550199'}, config.USER_PHONE_NUMBER), undefined);
    assert.equal(router.textReply({...reply, text: 'YES'}), undefined);
    assert.equal(router.textReply({...reply, text: `${old.id.slice(0, 8)} YES`}), undefined);
    current.clawMessageId = 'current-alert';
    assert.equal(router.textReply(parseClawMessage({...reply, text: 'YES'}, config.USER_PHONE_NUMBER)!)?.decision, 'allow');
    assert.equal(router.textReply({...reply, text: 'No', messageId: 'after-answer'}), undefined);
    assert.equal(router.textReply(reply), undefined);
    assert.equal(router.due(Date.now() + 100000).length, 0);
    const late = router.create('chat', 'late', 'Late request', 'approval', 60, Date.now()-61000).event;
    late.textDecision = true;
    assert.ok(router.claim(late.id));
    const resolved = router.textReply({...reply,messageId:'reply2',text:`${late.id.slice(0, 8)} NO`});
    assert.equal(resolved?.decision, null);
    assert.equal(resolved?.acknowledged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ElevenLabs speech requests phone-ready audio and forwards it unchanged', async () => {
  const frames: string[] = [];
  await streamSpeech({ ...config, ELEVENLABS_API_KEY: 'fake-key' }, 'Hello', new AbortController().signal, frame => frames.push(frame), async (url, options) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/test-voice/stream?output_format=ulaw_8000');
    assert.equal(new Headers(options?.headers).get('xi-api-key'), 'fake-key');
    assert.equal(JSON.parse(String(options?.body)).text, 'Hello');
    return new Response(Uint8Array.from([1, 2, 3]));
  });
  assert.deepEqual(frames, ['AQID']);
});

test('compiled configuration resolves the project root', () => {
  assert.ok(readFileSync(join(projectRoot, '.env.example'), 'utf8').includes('SIGNALWIRE_PROJECT_ID='));
});

test('MCP server advertises voice and status tools', async () => {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, 'dist/src/mcp-server.js')], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(t => t.name).sort(), ['ask_user_via_phone', 'check_voice_instructions', 'send_project_status_text', 'thumbs_up_imessage']);
  } finally { await client.close(); }
});

test('acknowledgment, resume, expiry, deduplication and restart retain correct call state', () => {
  const { dir, router: r } = tempRouter();
  try {
    r.touch('one', '/one'); r.touch('two', '/two');
    const a = r.create('one', 'turn1', 'Continue?', 'question', 90, Date.now() - 100000).event;
    assert.equal(r.create('one', 'turn1', 'duplicate', 'question', 90).fresh, false);
    assert.equal(r.due().length, 1);
    r.ack(a.id); assert.equal(r.due().length, 0); assert.equal(a.reply, null); assert.equal(a.decision, null);
    const b = r.create('one', 'turn2', 'Next?', 'question', 90, Date.now() - 100000).event;
    const c = r.create('two', 'turn3', 'Other?', 'question', 90, Date.now() - 100000).event;
    r.cancel('one'); assert.deepEqual(r.due().map(e => e.id), [c.id]);
    assert.throws(() => r.reply(b.id, 'yes'), /expired/);
    assert.ok(r.claim(c.id)); assert.equal(r.claim(c.id), null);
    const restarted = new Router(join(dir, 'state.json'));
    assert.equal(restarted.due().length, 0);
    assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
    r.queue('one', 'hello', 'instruction'); r.queue('one', 'duplicate', 'instruction');
    assert.equal(r.pending('one').length, 1); assert.equal(r.pending('two').length, 0);
    r.delivered('two', ['instruction']); assert.equal(r.pending('one').length, 1);
    r.delivered('one', ['instruction']); assert.equal(r.pending('one').length, 0);
    writeFileSync(join(dir, 'state.json'), '{broken');
    assert.throws(() => new Router(join(dir, 'state.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function signed(path: string, body: Record<string, string>) {
  const value = config.PUBLIC_WEBHOOK_URL + path + Object.keys(body).sort().map(key => key + body[key]).join('');
  return createHmac('sha1', config.SIGNALWIRE_SIGNING_KEY).update(value).digest('base64');
}
test('SignalWire signature binds URL, query and body', () => {
  const body = { From: config.USER_PHONE_NUMBER, To: config.SIGNALWIRE_PHONE_NUMBER };
  assert.ok(validSignature(config, signed('/voice/inbound', body), '/voice/inbound', body));
  assert.equal(validSignature(config, signed('/voice/inbound', body), '/voice/inbound?changed=1', body), false);
  assert.equal(validSignature(config, signed('/voice/inbound', body), '/voice/inbound', { ...body, From: '+12025550199' }), false);
});

test('HTTP auth, preview-safe ACK, PIN-free media, and cancellation during dial', async () => {
  const { dir, router } = tempRouter();
  const calls: string[] = [], hangs: string[] = [];
  let finishDial: ((value: { sid: string }) => void) | undefined;
  const providers = new Providers(config);
  providers.dial = async e => { calls.push(e.id); return new Promise(resolve => { finishDial = resolve; }); };
  providers.hangup = async sid => { hangs.push(sid); return { sid }; };
  const bridge = createBridge(config, router, providers);
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const address = bridge.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, data: unknown, auth = true) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${config.BRIDGE_TOKEN}` } : {}) }, body: JSON.stringify(data) });
  const voice = (path: string, body: Record<string, string>, signature = signed(path, body)) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-SignalWire-Signature': signature }, body: new URLSearchParams(body) });
  try {
    assert.equal((await fetch(base + '/internal/status')).status, 401);
    assert.equal((await post('/internal/activity', {}, true)).status, 400);
    assert.equal((await post('/internal/activity', { sessionId: 'one', cwd: '/workspace' })).status, 200);
    const event = router.create('one', 'turn', 'Test', 'question', 90, Date.now() - 100000).event;
    assert.equal((await fetch(`${base}/ack/${event.id}?token=wrong`)).status, 403);
    assert.equal((await fetch(`${base}/ack/${event.id}?token=${event.ackToken}`)).status, 200);
    assert.equal(event.acknowledged, false);
    const tick = bridge.tick();
    assert.equal(calls.length, 1);
    assert.equal((await post(`/ack/${event.id}`, { token: event.ackToken }, false)).status, 200);
    finishDial!({ sid: 'call-test' }); await tick;
    assert.deepEqual(hangs, ['call-test']);
    await bridge.tick(); assert.equal(calls.length, 1);
    const body = { AccountSid: config.SIGNALWIRE_PROJECT_ID, CallSid: 'incoming-call', From: config.USER_PHONE_NUMBER, To: config.SIGNALWIRE_PHONE_NUMBER };
    assert.equal((await fetch(base + '/voice/inbound', { method: 'POST' })).status, 403);
    assert.equal((await voice('/voice/inbound', body, 'bad')).status, 403);
    assert.match(await (await voice('/voice/inbound', { ...body, From: '+12025550199' })).text(), /<Reject/);
    const response = await (await voice('/voice/inbound', body)).text();
    const mediaPath = response.match(/url="wss:\/\/bridge\.example\.com(\/media-stream\/[a-f0-9]{64})"/)?.[1];
    assert.ok(mediaPath);
    assert.doesNotMatch(response, /<Gather|PIN/);
    assert.match(response, /statusCallback="https:\/\/bridge\.example\.com\/voice\/stream-status"/);
    const status = { StreamEvent: 'stream-error', StreamError: 'connection_refused' };
    assert.equal((await voice('/voice/stream-status', status, 'bad')).status, 403);
    assert.equal((await voice('/voice/stream-status', status)).status, 204);
    assert.match(await (await voice('/voice/inbound', body)).text(), /<Reject/);
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/media-stream');
    const [error] = await once(socket, 'error'); assert.match(String(error), /401/);
    const media = new WebSocket(base.replace('http:', 'ws:') + mediaPath);
    await once(media, 'open');
    const replay = new WebSocket(base.replace('http:', 'ws:') + mediaPath);
    const [replayError] = await once(replay, 'error'); assert.match(String(replayError), /401/);
    media.close(); await once(media, 'close');
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8').includes('test-not-a-key'), false);
  } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('hooks deliver queued instructions and leave permissions to Codex', async () => {
  const { dir, router } = tempRouter();
  const providers = new Providers(config);
  const codex = new CodexClient();
  codex.approvals = async () => [];
  const bridge = createBridge(config, router, providers, codex);
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const previousPort = process.env.PORT, previousToken = process.env.BRIDGE_TOKEN;
  process.env.PORT = String((bridge.server.address() as { port: number }).port);
  process.env.BRIDGE_TOKEN = config.BRIDGE_TOKEN;
  try {
    const identity = { session_id: 'hook-session', cwd: '/workspace', turn_id: 'turn1' };
    await handleHook({ ...identity, hook_event_name: 'SessionStart' });
    router.queue('hook-session', 'Use the blue version', 'msg1');
    const continuation = await handleHook({ ...identity, hook_event_name: 'Stop', last_assistant_message: 'Done' });
    assert.equal(continuation.decision, 'block');
    assert.equal(Object.keys(router.state.events).length, 0);
    assert.match(continuation.reason!, /blue version/);
    assert.equal(router.pending('hook-session').length, 0);
    const approvalInput = { ...identity, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'example-command' } };
    assert.deepEqual(await handleHook(approvalInput), {});
    await bridge.tick();
    assert.equal(Object.keys(router.state.events).length, 0);
  } finally {
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    if (previousToken === undefined) delete process.env.BRIDGE_TOKEN; else process.env.BRIDGE_TOKEN = previousToken;
    bridge.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('only the iMessage turn sends a final reply and a bare no can become a reaction', async () => {
  const { dir, router } = tempRouter();
  const actions: unknown[] = [];
  let receive: (message: ClawMessage) => void;
  class Messenger extends Claw {
    constructor(c: Config, incoming: (message: ClawMessage) => void) { super(c, incoming); receive = incoming; }
    typing(active: boolean) { actions.push(['typing', active]); }
    async send(text: string) { actions.push(['text', text]); }
    async react(id: string, type: string) { actions.push(['reaction', id, type]); return true; }
  }
  const codex = new CodexClient();
  codex.deliverText = async () => ({ turnId: 'phone-turn' });
  const bridge = createBridge(config, router, new Providers(config), codex, Messenger);
  await once(bridge.server.listen(0, '127.0.0.1'), 'listening');
  const oldPort = process.env.PORT, oldToken = process.env.BRIDGE_TOKEN;
  process.env.PORT = String((bridge.server.address() as { port: number }).port);
  process.env.BRIDGE_TOKEN = config.BRIDGE_TOKEN;
  const hook = (turn_id: string, last_assistant_message: string) => handleHook({
    session_id: 'chat', cwd: '/workspace', hook_event_name: 'Stop', turn_id, last_assistant_message,
  });
  try {
    router.touch('chat', '/workspace');
    receive!({ type: 'message', from: config.USER_PHONE_NUMBER, messageId: 'first', text: 'What is the status?' });
    await hook('desktop-turn', 'Private desktop reply');
    assert.deepEqual(actions, [['typing', true]]);
    await hook('phone-turn', 'The build passed.');
    await hook('phone-turn', 'The build passed.');
    assert.deepEqual(actions, [['typing', true], ['typing', false], ['text', 'The build passed.']]);
    receive!({ type: 'message', from: config.USER_PHONE_NUMBER, messageId: 'second', text: 'Is it deployed?' });
    await new Promise(resolve => setImmediate(resolve));
    await hook('phone-turn', 'No.');
    assert.deepEqual(actions.slice(-3), [['typing', true], ['typing', false], ['reaction', 'second', 'dislike']]);
  } finally {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    if (oldToken === undefined) delete process.env.BRIDGE_TOKEN; else process.env.BRIDGE_TOKEN = oldToken;
    bridge.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('only a confirmed desktop approval creates an alert and a plain text still reaches Codex', async () => {
  const { dir, router } = tempRouter();
  const codex = new CodexClient();
  codex.approvals = async () => ['desktop-approval:1'];
  const bridge = createBridge(config, router, new Providers(config), codex);
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const previousPort = process.env.PORT, previousToken = process.env.BRIDGE_TOKEN;
  process.env.PORT = String((bridge.server.address() as { port: number }).port);
  process.env.BRIDGE_TOKEN = config.BRIDGE_TOKEN;
  try {
    const input = { session_id: 'permission-chat', cwd: '/workspace', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'example-command' } };
    assert.deepEqual(await handleHook(input), {});
    assert.equal(Object.keys(router.state.events).length, 0);
    await bridge.tick();
    const event = Object.values(router.state.events)[0];
    assert.equal(event?.key, 'desktop-approval:1');
    assert.equal(event.textDecision, false);
    const message = { text: 'Use the blue version', messageId: 'valid-claw-reply' };
    assert.equal(router.textReply(message), undefined);
    assert.equal(router.followUp(message)?.sessionId, 'permission-chat');
    event.dueAt = Date.now() - 1;
    codex.approvals = async () => [];
    await bridge.tick();
    assert.equal(event.cancelled, true);
    assert.equal(event.callAttempted, false);
  } finally {
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    if (previousToken === undefined) delete process.env.BRIDGE_TOKEN; else process.env.BRIDGE_TOKEN = previousToken;
    bridge.close(); rmSync(dir, { recursive: true, force: true });
  }
});
