import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { deliverToDesktop, desktopApprovals, desktopApprovalDetails, desktopDecideApproval, desktopUpdateSettings, desktopModelSettings } from './desktop-client.js';

const listedSession = z.object({ id: z.string().uuid(), name: z.string().nullable(), cwd: z.string(), preview: z.string().optional() });
export type SessionChoice = { id: string; title: string; cwd: string };
export const effortLevels = { low: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', ultra: 'ultra' } as const;
const modelWords = (name: string) => name.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g)
  ?.filter(word => word !== 'gpt').sort().join(' ');

type CatalogModel = { model: string; displayName: string; hidden?: boolean; supportedReasoningEfforts?: { reasoningEffort: string }[] };
type Rpc = (method: string, params: unknown) => Promise<any>;

export function matchModel(input: string, catalog: CatalogModel[]) {
  const visible = catalog.filter(entry => !entry.hidden);
  const exact = visible.find(entry => entry.model.toLowerCase() === input.trim().toLowerCase());
  if (exact) return exact;
  const wanted = modelWords(input);
  if (!wanted) return;
  const matches = visible.filter(entry => modelWords(entry.model) === wanted || modelWords(entry.displayName) === wanted);
  if (matches.length === 1) return matches[0];
}

async function modelCatalog(rpc: Rpc, modelProvider?: string): Promise<CatalogModel[]> {
  const models = new Map<string, CatalogModel>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc('model/list', { limit: 100, modelProvider, cursor });
    for (const model of page.data as CatalogModel[]) models.set(model.model, model);
    cursor = page.nextCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  } while (cursor);
  return [...models.values()];
}

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
  async usage() {
    return this.withClient(async rpc => {
      const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: true });
      const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
      const windows = [bucket?.primary, bucket?.secondary];
      const used = (minutes: number) => {
        const percent = windows.find(window => window?.windowDurationMins === minutes)?.usedPercent;
        return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 ? percent : undefined;
      };
      return { fiveHour: used(300), weekly: used(10080) };
    });
  }
  async startSession(cwd?: string): Promise<SessionChoice> {
    return this.withClient(async rpc => {
      const { thread } = await rpc('thread/start', { cwd, ephemeral: false });
      const row = listedSession.parse(thread);
      return { id: row.id, cwd: row.cwd, title: row.name?.trim() || 'New session' };
    });
  }
  async setModel(threadId: string, input: string, effort?: string) {
    return this.withClient(async rpc => {
      const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
      if (thread.id !== threadId) throw new Error('Selected chat is unavailable');
      const match = matchModel(input, await modelCatalog(rpc, thread.modelProvider));
      if (!match) return;
      if (effort && !match.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) return null;
      await this.updateSettings(rpc, threadId, { model: match.model, ...(effort ? { effort } : {}) });
      return match.displayName;
    });
  }
  async setEffort(threadId: string, effort: string) {
    return this.withClient(async rpc => {
      const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
      if (thread.id !== threadId) throw new Error('Selected chat is unavailable');
      const settings = await desktopModelSettings(this.desktopPath, threadId);
      const modelId = settings?.model ?? thread.model;
      const model = (await modelCatalog(rpc, thread.modelProvider)).find(entry => entry.model === modelId);
      if (!model?.supportedReasoningEfforts) throw new Error('Current model effort options are unavailable');
      const supported = model.supportedReasoningEfforts;
      if (!Array.isArray(supported) || !supported.some(option => option.reasoningEffort === effort)) return false;
      await this.updateSettings(rpc, threadId, { effort });
      return true;
    });
  }
  private async updateSettings(rpc: (method: string, params: unknown) => Promise<unknown>, threadId: string,
    settings: { model?: string; effort?: string }) {
    const applied = await desktopUpdateSettings(this.desktopPath, threadId, settings);
    if (applied === false) throw new Error('Desktop rejected settings change');
    if (applied === undefined) {
      if (!(await this.sessions()).some(session => session.id === threadId)) throw new Error('Selected chat is unavailable');
      await rpc('thread/settings/update', { threadId, ...settings });
    }
  }
  async sessions(): Promise<SessionChoice[]> {
    return this.withClient(async rpc => {
      const sessions = new Map<string, SessionChoice>();
      let cursor: string | null = null;
      do {
        const page = await rpc('thread/list', { cursor, limit: 50, archived: false, currentAccountOnly: true });
        for (const item of page.data ?? []) {
          if (item.parentThreadId || item.ephemeral) continue;
          const row = listedSession.safeParse(item);
          if (!row.success) continue;
          const { id, name, cwd, preview } = row.data;
          const title = (name?.trim() || preview?.trim() || 'Untitled session').replace(/\s+/g, ' ').slice(0, 100);
          sessions.set(id, { id, cwd, title });
        }
        const next = page.nextCursor ?? null;
        if (next === cursor) break;
        cursor = next;
      } while (cursor);
      return [...sessions.values()];
    });
  }
  approvals(threadId: string) {
    return desktopApprovals(this.desktopPath, threadId).catch(() => undefined);
  }
  approvalDetails(threadId: string, key: string) {
    return desktopApprovalDetails(this.desktopPath, threadId, key).catch(() => undefined);
  }
  decideApproval(threadId: string, key: string, command: string, allow: boolean) {
    return desktopDecideApproval(this.desktopPath, threadId, key, command, allow);
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
        if (thread.id !== threadId) throw new Error('Target chat is unavailable');
        if (thread.status?.type === 'notLoaded') {
          if (!(await this.sessions()).some(session => session.id === threadId)) throw new Error('Target chat is unavailable');
          await rpc('thread/resume', { threadId, excludeTurns: true });
        }
        sent = true;
        const { turn } = await rpc('turn/start', { threadId, clientUserMessageId: messageId, input: [{ type: 'text', text, text_elements: [] }] });
        return { turnId: turn?.id as string | undefined };
      });
    } catch { throw new DeliveryError(sent); }
  }
}
