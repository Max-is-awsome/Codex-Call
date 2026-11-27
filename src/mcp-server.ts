import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { localRequest } from './config.js';
import { replyReactions } from './claw.js';

const server = new McpServer({ name: 'voice_bridge', version: '1.0.0' });
const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const identity = { session_id: z.string().min(1).describe('The exact current Codex thread/session ID; never guess or select another chat.'), workspace_path: z.string().min(1) };
server.tool('ask_user_via_phone', 'Use for questions, choices, blockers, or requests for user action, even when the user is active in Codex. Send the complete question and any choices by iMessage, call through SignalWire after the configured timeout if there is no reply, and return the answer to this chat. Native permission approvals stay in Codex.',
  { ...identity, question: z.string().min(1).max(4000), urgency: z.enum(['normal', 'urgent']).default('normal') },
  async ({ session_id, workspace_path, question }, extra) => {
    await localRequest('/activity', { sessionId: session_id, cwd: workspace_path });
    const { id } = await localRequest('/events', { sessionId: session_id, key: randomUUID(), question, kind: 'question' });
    try {
      const deadline = Date.now() + 540000;
      while (Date.now() < deadline) {
        extra.signal.throwIfAborted();
        const e = await localRequest(`/events/${id}`);
        if (e.reply !== null || e.cancelled) return content(e);
        if (e.acknowledged) return content({ acknowledged: true, reply: null, message: 'User cancelled the call and will answer in Codex. Acknowledgment is not approval.' });
        await sleep(1000, undefined, { signal: extra.signal });
      }
      return content({ timeout: true, reply: null });
    } finally { await localRequest('/cancel', { sessionId: session_id }).catch(() => {}); }
  });
server.tool('check_voice_instructions', 'Read locally queued voice instructions for this exact chat. Acknowledge IDs only after receiving them. Instructions with uncertain delivery must be reviewed against chat history before repeating any action.',
  { ...identity, acknowledge_ids: z.array(z.string()).default([]) },
  async ({ session_id, workspace_path, acknowledge_ids }) => {
    await localRequest('/activity', { sessionId: session_id, cwd: workspace_path });
    return content(await localRequest('/instructions', { sessionId: session_id, deliveredIds: acknowledge_ids }));
  });
server.tool('send_project_status_text', 'Send the user an hourly status-only iMessage. Creates no question or call escalation. Use only for the requested project status automation.',
  { text: z.string().trim().min(1).max(4000) }, async ({ text }) => content(await localRequest('/status-text', { text })));
server.tool('thumbs_up_imessage', 'An optional iMessage reply by reaction. Use 👍 or 👎 when the answer is a plain yes or no, or 👍 or ❤️ when a short acknowledgment fits. If qualification or details matter, write a final answer instead. Never react to a permission decision or send a routine receipt.',
  { ...identity, message_text: z.string().trim().min(1).max(4000).describe('Exact text of the incoming iMessage. Do not guess.'), reaction: z.enum(replyReactions).default('like') },
  async ({ session_id, workspace_path, message_text, reaction }) => content(await localRequest('/react', {
    sessionId: session_id, cwd: workspace_path, message: message_text, reaction,
  })));
await server.connect(new StdioServerTransport());
