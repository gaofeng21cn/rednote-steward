import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../opencli-runner.mjs', import.meta.url));
const browserArgs = ['--window', 'background', '--keep-tab', 'false', '-f', 'json'];
export function extractJson(stdout) {
  try { return JSON.parse(stdout.trim()); } catch { /* OpenCLI may prefix diagnostics. */ }
  for (const [index, char] of [...stdout].entries()) {
    if (char !== '{' && char !== '[') continue;
    try { return JSON.parse(stdout.slice(index).trim()); } catch { /* next candidate */ }
  }
  return null;
}
export function runOpencli(args, { timeoutMs = 300_000, profile, onSpawn } = {}) {
  return new Promise(resolve => {
    const override = process.env.XHS_OPS_OPENCLI_BIN;
    const executable = override || process.execPath;
    const argv = override ? args : [runner, ...args];
    const env = { ...process.env };
    if (profile) env.OPENCLI_PROFILE = profile;
    const browserSeconds = Math.max(60, Math.ceil(timeoutMs / 1000));
    env.OPENCLI_BROWSER_COMMAND_TIMEOUT = String(browserSeconds);
    const child = spawn(executable, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false, escalation, spawnSetupError = false;
    if (child.pid && onSpawn) {
      try { onSpawn(child.pid); } catch (error) { spawnSetupError = true; stderr += `${error.message}\n`; child.kill('SIGTERM'); }
    }
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      resolve({ exitCode: spawnSetupError ? -1 : code ?? -1, stdout, stderr, timedOut, json: extractJson(stdout) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += `${error.message}\n`; finish(-1); });
    child.on('close', finish);
  });
}
export function readAccount(profile) {
  return runOpencli(['xiaohongshu', 'steward-account', ...browserArgs], { timeoutMs: 60_000, profile });
}
export function readInventory(limit = 30, profile) {
  return runOpencli(['xiaohongshu', 'inventory', '--limit', String(limit), ...browserArgs], { profile });
}
export function readNote(id, profile) {
  return runOpencli(['xiaohongshu', 'steward-read-note', id, ...browserArgs], { profile });
}
export function readMetrics(limit = 120, profile) {
  return runOpencli(['xiaohongshu', 'creator-notes-summary', '--limit', String(limit), '--timeout', '600', ...browserArgs], { timeoutMs: 660_000, profile });
}
export function publishArgs(task) {
  const args = ['xiaohongshu', 'steward-publish', task.body, '--title', task.title];
  if (task.video) args.push('--video', task.video.path);
  else args.push('--images', task.images.map(image => image.path).join(','));
  if (task.cover) args.push('--cover', task.cover.path);
  args.push('--topics', task.topics.join(','), ...browserArgs);
  return args;
}
export function editArgs(task) {
  const args = ['xiaohongshu', 'edit-note', task.source_note_id, '--title', task.title,
    '--content', task.body, '--topics', task.topics.join(',')];
  if (task.images.length) args.push('--images', task.images.map(image => image.path).join(','));
  if (task.video) args.push('--video', task.video.path);
  args.push(...browserArgs);
  return args;
}
export function rowOf(value) { return Array.isArray(value) ? value[0] : value; }
export async function verifiedIdentity(account) {
  const response = await readAccount(account.profile);
  const identity = rowOf(response.json);
  if (response.exitCode !== 0 || identity?.logged_in !== true) {
    throw new Error(response.stderr.trim() || 'Xiaohongshu login required');
  }
  if (!identity.userId || String(identity.userId) !== account.userId) {
    throw new Error(`Account identity mismatch: expected ${account.userId}, observed ${identity?.userId ?? 'unavailable'}`);
  }
  return identity;
}
