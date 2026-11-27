import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

type Frame = {
  type: string;
  requestId: string;
  resultType?: string;
  handledByClientId?: string;
  result?: { clientId?: string; result?: { turnId?: string; turn?: { id?: string } } };
  error?: string;
  method?: string;
  sourceClientId?: string;
  params?: {
    conversationId?: string;
    change?: { type?: string; conversationState?: { requests?: { method?: string; id?: unknown }[] } };
  };
};

// shortcut: the desktop IPC is versioned but private; use lifecycle delivery if the desktop stops accepting it.
async function withDesktop<T>(path: string, threadId: string, run: (client: {
  owner: string;
  request: (method: string, version: number, params: object, targetClientId?: string) => Promise<Frame>;
  snapshot: () => Promise<Frame>;
}) => Promise<T>): Promise<T | undefined> {
  const socket = createConnection(path);
  const timeoutMs = 5000;
  const maxFrame = 4 * 1024 * 1024;
  let sourceClientId = 'initializing-client';
  let buffer = Buffer.alloc(0);
  let pending: { id: string; resolve: (response: Frame) => void; reject: (error: Error) => void } | undefined;
  let onSnapshot: ((frame: Frame) => void) | undefined;
  let owner: string | undefined;
  const disconnected = () => pending?.reject(new Error('Desktop connection closed'));
  socket.on('error', disconnected);
  socket.on('close', disconnected);
  const send = (message: object) => {
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    socket.write(Buffer.concat([header, payload]));
  };
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      if (length > maxFrame) { socket.destroy(); return; }
      if (buffer.length < length + 4) return;
      let frame: Frame;
      try { frame = JSON.parse(buffer.subarray(4, length + 4).toString()); }
      catch { socket.destroy(); return; }
      buffer = buffer.subarray(length + 4);
      if (frame?.type === 'client-discovery-request') {
        send({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } });
      } else if (frame?.type === 'response' && pending?.id === frame.requestId) {
        pending.resolve(frame);
      } else if (frame?.type === 'broadcast' && frame.method === 'thread-stream-state-changed' && frame.sourceClientId === owner
        && frame.params?.conversationId === threadId && frame.params.change?.type === 'snapshot') {
        onSnapshot?.(frame);
      }
    }
  });

  async function request(method: string, version: number, params: object, targetClientId?: string) {
    const id = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<Frame>((resolve, reject) => {
        pending = { id, resolve, reject };
        timer = setTimeout(() => reject(new Error('Desktop request timed out')), timeoutMs + 1000);
        send({ type: 'request', requestId: id, sourceClientId, version, method, params, targetClientId, timeoutMs });
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
  }

  try {
    try {
      const hello = await request('initialize', 1, { clientType: 'voice-bridge' });
      if (hello.resultType !== 'success' || !hello.result?.clientId) return;
      sourceClientId = hello.result.clientId;
      const discovery = await request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
      if (discovery.resultType === 'success') owner = discovery.handledByClientId;
    } catch { return; }
    if (!owner) return;
    return await run({ owner, request, snapshot: async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await new Promise<Frame>((resolve, reject) => {
          onSnapshot = resolve;
          timer = setTimeout(() => reject(new Error('Desktop snapshot unavailable')), 1500);
          send({
            type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
            sourceClientId, targetClientIds: [owner], params: { hostId: 'local', conversationId: threadId, following: true },
          });
        });
      } finally { clearTimeout(timer); onSnapshot = undefined; }
    } });
  } finally { socket.destroy(); }
}

const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);

export async function desktopApprovals(path: string, threadId: string) {
  return withDesktop(path, threadId, async ({ snapshot }) => {
    const frame = await snapshot();
    const requests = frame.params?.change?.conversationState?.requests;
    return Array.isArray(requests) ? requests.filter(r => r?.method && approvalMethods.has(r.method)
      && (typeof r.id === 'string' || typeof r.id === 'number')).map(r => `desktop-approval:${JSON.stringify(r.id)}`) : undefined;
  });
}

export async function deliverToDesktop(path: string, threadId: string, text: string, messageId: string): Promise<{ turnId?: string } | false> {
  return (await withDesktop(path, threadId, async ({ owner, request }) => {
    const input = [{ type: 'text', text, text_elements: [] }];
    const restoreMessage = {
      id: messageId,
      text,
      context: {
        prompt: text, workspaceRoots: [], imageAttachments: [], fileAttachments: [], addedFiles: [],
        commentAttachments: [], responseTextAnnotations: [], attachmentOrder: [],
      },
    };
    const steer = await request('thread-follower-steer-turn', 1, {
      conversationId: threadId, clientUserMessageId: messageId, input, restoreMessage, additionalContext: {},
    }, owner);
    if (steer.resultType === 'success') return { turnId: steer.result?.result?.turnId };
    if (steer.error === 'no-client-found') return false;
    if (!steer.error?.includes('because its active turn already ended')) throw new Error('Desktop steering outcome is uncertain');

    const start = await request('thread-follower-start-turn', 2, {
      conversationId: threadId,
      turnStart: {
        request: { threadId, input, clientUserMessageId: messageId },
        context: { restoreMessage, inheritThreadSettings: true },
      },
    }, owner);
    if (start.resultType === 'success') return { turnId: start.result?.result?.turn?.id };
    if (start.error === 'no-client-found') return false;
    throw new Error('Desktop start outcome is uncertain');
  })) ?? false;
}
