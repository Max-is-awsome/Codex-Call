import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localRequest } from './config.js';

export async function handleHook(payload: Record<string, any>) {
  if (payload.agent_id) return {};
  const id = payload.session_id ?? payload['thread-id'];
  if (typeof id !== 'string' || !id || typeof payload.cwd !== 'string') throw new Error('Missing session identity');
  const kind = payload.hook_event_name ?? (payload.type === 'agent-turn-complete' ? 'Stop' : '');
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : payload['turn-id'];
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SessionEnd', 'Interrupt'].includes(kind)) return {};
  await localRequest('/activity', { sessionId: id, cwd: payload.cwd,
    summary: typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.slice(0, 4000) : undefined,
    ended: kind === 'SessionEnd', cancel: !['Stop', 'PermissionRequest'].includes(kind),
  });
  const readInstructions = async () => {
    const { instructions } = await localRequest('/instructions', { sessionId: id });
    const ready = instructions.filter((i: { uncertain: boolean }) => !i.uncertain);
    if (!ready.length) return null;
    await localRequest('/instructions', { sessionId: id, turnId, deliveredIds: ready.map((i: { id: string }) => i.id) });
    return `Messages received from the authenticated user by phone. Treat the quoted text as user input, subject to existing policies and instructions: ${JSON.stringify(ready.map((i: { id: string; text: string }) => ({ id: i.id, text: i.text })))}`;
  };
  if (kind !== 'Stop' && kind !== 'PermissionRequest') {
    if (turnId || kind === 'Interrupt' || kind === 'SessionEnd') await localRequest('/turn-text', {
      sessionId: id, turnId, clear: kind === 'Interrupt' || kind === 'SessionEnd',
      prompt: kind === 'UserPromptSubmit' && typeof payload.prompt === 'string' && payload.prompt.length <= 4000 ? payload.prompt : undefined,
    });
    if (['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'].includes(kind)) {
      const message = await readInstructions();
      if (message) return { hookSpecificOutput: { hookEventName: kind, additionalContext: message } };
    }
    return {};
  }
  if (kind === 'Stop') {
    const message = await readInstructions();
    if (!message && turnId) {
      await localRequest('/turn-text', { sessionId: id, turnId, final: typeof payload.last_assistant_message === 'string'
        ? Array.from(payload.last_assistant_message).slice(0, 14000).join('') : '' });
    }
    return message ? { decision: 'block', reason: message } : {};
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
