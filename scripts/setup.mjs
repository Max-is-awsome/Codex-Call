import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
let codex = 'codex';
try { codex = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim(); } catch {}
if (!existsSync(envPath)) {
  let env = readFileSync(join(root, '.env.example'), 'utf8');
  env = env.replace(/^BRIDGE_TOKEN=$/m, `BRIDGE_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(/^CODEX_BIN=codex$/m, `CODEX_BIN=${JSON.stringify(codex)}`);
  writeFileSync(envPath, env, { mode: 0o600, flag: 'wx' });
}
chmodSync(envPath, 0o600);
for (const directory of ['data', 'logs']) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = `${shellQuote(process.execPath)} ${shellQuote(join(root, 'dist/src/escalate-hook.js'))}`;
const hooks = { hooks: {} };
for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']) {
  hooks.hooks[event] = [{ hooks: [{ type: 'command', command, timeout: ['PermissionRequest', 'Stop'].includes(event) ? 570 : 10 }] }];
}
hooks.hooks.Interrupt = [{ hooks: [{ type: 'command', command, timeout: 3 }] }];
writeFileSync(join(root, 'hooks.generated.json'), JSON.stringify(hooks, null, 2) + '\n');
const escapeXml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.user.codex-voice-bridge</string>
<key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(join(root, 'scripts/start.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escapeXml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escapeXml(join(root, 'logs/server.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(join(root, 'logs/server-error.log'))}</string>
</dict></plist>\n`;
writeFileSync(join(root, 'com.user.codex-voice-bridge.plist'), plist);
if (process.argv.includes('--activate')) {
  const { serverConfig } = await import('../dist/src/config.js');
  serverConfig(); // Refuse to install live hooks or a restart loop with missing credentials.
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  mkdirSync(codexHome, { recursive: true });
  const hookPath = join(codexHome, 'hooks.json');
  const stamp = Date.now();
  const existing = existsSync(hookPath) ? JSON.parse(readFileSync(hookPath, 'utf8')) : { hooks: {} };
  if (existsSync(hookPath)) copyFileSync(hookPath, `${hookPath}.backup-${stamp}`);
  existing.hooks ??= {};
  for (const [event, entries] of Object.entries(hooks.hooks)) {
    const previous = existing.hooks[event] || [];
    const withoutBridge = previous.map(entry => ({ ...entry, hooks: (entry.hooks || []).filter(h => h.command !== command) })).filter(entry => entry.hooks.length);
    existing.hooks[event] = [...withoutBridge, ...entries];
  }
  const configPath = join(codexHome, 'config.toml');
  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.backup-${stamp}`);
  // The CLI edits TOML itself, preserving unrelated configuration.
  execFileSync(process.env.CODEX_BIN || codex, ['mcp', 'add', 'voice_bridge', '--', process.execPath, join(root, 'dist/src/mcp-server.js')], { stdio: 'inherit' });
  let inBridge = false;
  const configLines = readFileSync(configPath, 'utf8').split('\n').flatMap(line => {
    if (/^\s*\[/.test(line)) inBridge = /^\s*\[mcp_servers\.voice_bridge\]\s*$/.test(line);
    if (inBridge && /^\s*tool_timeout_sec\s*=/.test(line)) return [];
    return /^\s*\[mcp_servers\.voice_bridge\]\s*$/.test(line) ? [line, 'tool_timeout_sec = 600'] : [line];
  });
  writeFileSync(configPath, configLines.join('\n'));
  writeFileSync(hookPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  const agentsPath = join(codexHome, 'AGENTS.md');
  const original = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const bridgeInstructions = `<!-- codex-voice-bridge -->
When you need the user to answer a question, make a choice, respond to a blocker, or do something so work can continue, ask through voice_bridge.ask_user_via_phone first, even when they are active in Codex. Send the complete question and any choices in one iMessage. Use the exact current chat ID and workspace path. Do not send a duplicate desktop question card. If the bridge is unavailable or the user asks to answer in Codex, use the desktop chat. Treat the returned reply as user input. Native permission prompts stay in Codex.
Check voice_bridge.check_voice_instructions at natural pauses and acknowledge received instruction IDs. A push acknowledgment is not approval. Review uncertain deliveries against chat history before repeating an action.
When a consequential iMessage instruction calls for a thoughtful acknowledgment before the work is finished, use voice_bridge.thumbs_up_imessage with keep_reply=true, then continue and send the final answer. Use the exact message text and skip routine receipts.
<!-- /codex-voice-bridge -->`;
  const bridgeBlock = /<!-- codex-voice-bridge -->[\s\S]*?<!-- \/codex-voice-bridge -->/;
  const updated = bridgeBlock.test(original) ? original.replace(bridgeBlock, bridgeInstructions) : original + '\n' + bridgeInstructions + '\n';
  if (updated !== original) {
    if (existsSync(agentsPath)) copyFileSync(agentsPath, `${agentsPath}.backup-${stamp}`);
    writeFileSync(agentsPath, updated);
  }
  const launchDir = join(homedir(), 'Library/LaunchAgents');
  mkdirSync(launchDir, { recursive: true });
  const destination = join(launchDir, 'com.user.codex-voice-bridge.plist');
  if (existsSync(destination)) copyFileSync(destination, `${destination}.backup-${stamp}`);
  writeFileSync(destination, plist);
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.user.codex-voice-bridge`], { stdio: 'ignore' }); } catch {}
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, destination], { stdio: 'inherit' });
  console.log('Installed MCP, lifecycle hooks, instructions, and launchd service. Review/trust the new hooks in Codex, then restart Codex.');
} else {
  console.log(`Prepared private configuration: ${envPath}\nFill the blank values before activation. No service or live hooks have been installed.`);
}
