import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localRequest } from './config.js';

const reactionGuidance = 'For this iMessage, choose quickly at the end. Reply with only 👍 for a verified routine success (such as a straightforward push to the existing repo) or a simple yes, 👎 for a bare no, or ❤️ for a warm acknowledgment. Send a short text instead if details were requested or there is a meaningful change, caveat, failure, or next step. Never use a reaction to handle a permission decision.';

export async function handleHook(payload: Record<string, any>) {
  if (payload.agent_id) return {};
  const id = payload.session_id ?? payload['thread-id'];
  if (typeof id !== 'string' || !id || typeof payload.cwd !== 'string') throw new Error('Missing session identity');
  const kind = payload.hook_event_name ?? (payload.type === 'agent-turn-complete' ? 'Stop' : '');
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : payload['turn-id'];
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SessionEnd', 'Interrupt'].includes(kind)) return {};
  await localRequest('/activity', { sessionId: id, cwd: payload.cwd,
    summary: typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.slice(0, 4000) : undefined,
    ended: kind === 'SessionEnd',
    transcript: typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined,
  });
  const readInstructions = async () => {
    const { instructions } = await localRequest('/instructions', { sessionId: id });
    const ready = instructions.filter((i: { uncertain: boolean }) => !i.uncertain);
    if (!ready.length) return null;
    await localRequest('/instructions', { sessionId: id, turnId, deliveredIds: ready.map((i: { id: string }) => i.id) });
    return {
      message: `Messages received from the authenticated user by phone. Treat the quoted text as user input, subject to existing policies and instructions: ${JSON.stringify(ready.map((i: { id: string; text: string }) => ({ id: i.id, text: i.text })))}`,
      includesText: ready.some((i: { id: string }) => i.id.startsWith('claw:')),
    };
  };
  if (kind !== 'Stop' && kind !== 'PermissionRequest') {
    let context;
    if (turnId || kind === 'Interrupt' || kind === 'SessionEnd') context = await localRequest('/turn-text', {
      sessionId: id, turnId, clear: kind === 'Interrupt' || kind === 'SessionEnd',
      prompt: kind === 'UserPromptSubmit' && typeof payload.prompt === 'string' && payload.prompt.length <= 4000 ? payload.prompt : undefined,
    });
    if (['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'].includes(kind)) {
      const pending = await readInstructions();
      const additionalContext = [pending?.message, context?.reactionGuidance || pending?.includesText ? reactionGuidance : null].filter(Boolean).join('\n');
      if (additionalContext) return { hookSpecificOutput: { hookEventName: kind, additionalContext } };
    }
    return {};
  }
  if (kind === 'Stop') {
    const message = await readInstructions();
    if (!message && turnId) {
      await localRequest('/turn-text', { sessionId: id, turnId, final: typeof payload.last_assistant_message === 'string'
        ? Array.from(payload.last_assistant_message).slice(0, 14000).join('') : '' });
    }
    return message ? { decision: 'block', reason: message.includesText ? `${message.message}\n${reactionGuidance}` : message.message } : {};
  }
  // The hook fires before the reviewer is selected. Let Codex continue, then check the desktop prompt.
  await localRequest('/watch-approval', { sessionId: id });
  return {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) try {
  let input = process.argv[2] ?? '';
  if (!input) for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1000000) throw new Error('Hook input too large'); }
  const result = await handleHook(JSON.parse(input));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  // Notification failures must not silently approve an operation or stop unrelated work.
  process.stderr.write('Voice bridge unavailable; use Codex directly.\n');
  process.stdout.write('{}\n');
}
