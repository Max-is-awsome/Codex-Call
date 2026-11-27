import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';

// Compiled files live in dist/src; configuration stays at the project root.
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
try { loadEnvFile(resolve(projectRoot, '.env')); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

const httpsOrigin = z.string().refine(value => {
  const u = URL.parse(value);
  return !!u && u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
}, 'Use an HTTPS origin without a path, query, or credentials');
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
export function serverConfig() {
  const result = z.object({
    SIGNALWIRE_SPACE_URL: httpsOrigin.refine(v => URL.parse(v)?.hostname.endsWith('.signalwire.com') === true),
    SIGNALWIRE_PROJECT_ID: z.string().uuid(), SIGNALWIRE_API_TOKEN: z.string().min(10),
    SIGNALWIRE_SIGNING_KEY: z.string().min(10), SIGNALWIRE_PHONE_NUMBER: phone, USER_PHONE_NUMBER: phone,
    OPENAI_API_KEY: z.string().min(10), OPENAI_REALTIME_MODEL: z.string().min(1).default('gpt-realtime'),
    DEEPGRAM_API_KEY: z.string().trim().optional(),
    CLAW_API_KEY: z.preprocess(value => value || undefined, z.string().regex(/^cm_live_[A-Za-z0-9_-]+$/).optional()),
    PUBLIC_WEBHOOK_URL: httpsOrigin,
    BRIDGE_TOKEN: z.string().min(32),
    ELEVENLABS_API_KEY: z.string().optional(),
    FISH_AUDIO_API_KEY: z.string().trim().optional(),
    FISH_AUDIO_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true').optional(),
    FISH_AUDIO_VOICE_ID: z.preprocess(value => value || '33f31ddfa74249a683ead2792088622d', z.string().regex(/^[a-f0-9]{32}$/i)).optional(),
    ELEVENLABS_VOICE_ID: z.preprocess(value => value || 'pNInz6obpgDQGcFmaJgB', z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)),
    PORT: z.coerce.number().int().min(1024).max(65535).default(3456),
    ESCALATION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    CODEX_BIN: z.string().default('codex'),
  }).safeParse(process.env);
  if (!result.success) throw new Error(`Set valid values in .env for: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
  return result.data;
}
export type Config = ReturnType<typeof serverConfig>;

export async function localRequest(path: string, body?: unknown) {
  const token = process.env.BRIDGE_TOKEN;
  if (!token) throw new Error('Run npm run setup and fill .env first');
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3456}/internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
  return response.json();
}
