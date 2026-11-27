import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { deliverToDesktop, desktopApprovals } from './desktop-client.js';

export class DeliveryError extends Error {
  constructor(public uncertain: boolean) { super(uncertain ? 'Delivery is uncertain' : 'Chat is unavailable on this daemon'); }
}

// The existing daemon's control socket carries WebSocket frames, not stdio JSON lines.
export class CodexClient {
  constructor(
    private socketPath = process.env.CODEX_SOCKET_PATH || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock'),
    private desktopPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'ipc/ipc.sock'),
  ) {}
  async withClient<T>(fn: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
    const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, { handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024 });
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    let id = 0;
    const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex daemon disconnected')); } pending.clear(); };
    socket.on('error', fail); socket.on('close', fail);
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const p = pending.get(message.id);
      if (p && !message.method) {
        pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(new Error('Codex rejected the request')) : p.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Use the original client for this request' } }));
      }
    });
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Codex is not connected'));
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Codex request timed out; delivery may be uncertain')); }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    try {
      await once(socket, 'open');
      await rpc('initialize', { clientInfo: { name: 'codex_voice_bridge', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      socket.send(JSON.stringify({ method: 'initialized' }));
      return await fn(rpc);
    } finally { socket.terminate(); fail(); }
  }
  async status(threadId: string) {
    return this.withClient(async rpc => (await rpc('thread/read', { threadId, includeTurns: false })).thread);
  }
  approvals(threadId: string) {
    return desktopApprovals(this.desktopPath, threadId).catch(() => undefined);
  }
  async deliverText(threadId: string, text: string, messageId: string) {
    try {
      const desktop = await deliverToDesktop(this.desktopPath, threadId, text, messageId);
      if (desktop) return desktop;
    } catch { throw new DeliveryError(true); }
    return this.deliver(threadId, text, messageId);
  }
  async deliver(threadId: string, text: string, messageId: string) {
    let sent = false;
    try {
      return await this.withClient(async rpc => {
        const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
        if (thread.id !== threadId || thread.status?.type === 'notLoaded') throw new Error('Target chat is not loaded');
        sent = true;
        const { turn } = await rpc('turn/start', { threadId, clientUserMessageId: messageId, input: [{ type: 'text', text, text_elements: [] }] });
        return { turnId: turn?.id as string | undefined };
      });
    } catch { throw new DeliveryError(sent); }
  }
}
