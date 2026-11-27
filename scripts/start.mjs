import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
loadEnvFile('.env');
const { serverConfig } = await import('../dist/src/config.js');
const config = serverConfig();
const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
};
const run = (command, args, env = process.env) => {
  const child = spawn(command, args, { stdio: 'inherit', env });
  children.push(child);
  child.on('error', () => { console.error(`Cannot start ${command}`); stop(1); });
  child.on('exit', code => stop(code ?? 1));
};
if (process.env.CLOUDFLARED_TUNNEL_TOKEN) {
  run('cloudflared', ['tunnel', '--no-autoupdate', 'run'], { ...process.env, TUNNEL_TOKEN: process.env.CLOUDFLARED_TUNNEL_TOKEN });
} else if ((process.env.TUNNEL_PROVIDER || 'ngrok') === 'ngrok') {
  run('ngrok', ['http', '--inspect=false', `--url=${config.PUBLIC_WEBHOOK_URL}`, `http://127.0.0.1:${config.PORT}`]);
}
run(process.execPath, ['dist/src/server.js']);
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
