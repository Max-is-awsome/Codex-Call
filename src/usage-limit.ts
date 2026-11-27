import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const sessions = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

export function rolloutPath(path: string, sessionId: string) {
  const file = resolve(path);
  const fromSessions = relative(sessions, file);
  if (/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(fromSessions)
    && basename(file).endsWith(`-${sessionId}.jsonl`)) return file;
}

export async function latestUsageLimit(file: string, since: number) {
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat();
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines.reverse()) {
      if (!line.includes('usage_limit_exceeded')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const task = record?.payload;
      if (record?.type === 'event_msg' && task?.type === 'task_complete' && task.error?.codex_error_info === 'usage_limit_exceeded'
        && Date.parse(record.timestamp) >= since && typeof task.turn_id === 'string'
        && (!task.root_turn_id || task.root_turn_id === task.turn_id)) return task.turn_id as string;
    }
  } finally { await fd.close(); }
}
