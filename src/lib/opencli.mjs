import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProgressReader } from './progress.mjs';

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
export function runOpencli(args, { timeoutMs = 300_000, profile, onSpawn, onProgress } = {}) {
  return new Promise(resolve => {
    const override = process.env.XHS_OPS_OPENCLI_BIN;
    const executable = override || process.execPath;
    const argv = override ? args : [runner, ...args];
    const env = { ...process.env };
    // Only the managed caller consumes progress; raw OpenCLI output stays quiet.
    if (onProgress) env.XHS_OPS_PROGRESS = '1';
    if (profile) env.OPENCLI_PROFILE = profile;
    // Let OpenCLI report a timeout before the outer process deadline kills it.
    const browserSeconds = Math.max(1, Math.floor((timeoutMs - Math.min(5000, timeoutMs / 2)) / 1000));
    env.OPENCLI_BROWSER_COMMAND_TIMEOUT = String(browserSeconds);
    const child = spawn(executable, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false, escalation, spawnSetupError = false;
    const progress = [];
    const appendDiagnostic = value => { stderr = (stderr + value).slice(-2 * 1024 * 1024); };
    const progressReader = createProgressReader(event => {
      if (progress.length < 200) progress.push(event);
      if (!onProgress || spawnSetupError) return;
      try { onProgress(event); }
      catch (error) {
        spawnSetupError = true;
        appendDiagnostic(`Progress persistence failed: ${error.message}\n`);
        child.kill('SIGTERM');
      }
    }, appendDiagnostic);
    if (child.pid && onSpawn) {
      try { onSpawn(child.pid); } catch (error) { spawnSetupError = true; stderr += `${error.message}\n`; child.kill('SIGTERM'); }
    }
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      progressReader.end();
      resolve({ exitCode: spawnSetupError ? -1 : code ?? -1, stdout, stderr, timedOut, json: extractJson(stdout), progress });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { progressReader.write(chunk); });
    child.on('error', error => { stderr += `${error.message}\n`; finish(-1); });
    child.on('close', finish);
  });
}
export function readAccount(profile) {
  return runOpencli(['xiaohongshu', 'steward-account', ...browserArgs], { timeoutMs: 60_000, profile });
}
export function readInventory(limit = 30, profile, { includeMeta = false } = {}) {
  return runOpencli([
    'xiaohongshu',
    'inventory',
    '--limit',
    String(limit),
    ...(includeMeta ? ['--include-meta', 'true'] : []),
    ...browserArgs,
  ], { profile });
}
export function readNote(id, profile, noteType = 'normal') {
  return runOpencli(['xiaohongshu', 'steward-read-note', id, '--note-type', noteType, ...browserArgs], { profile });
}
export function readMetrics(limit = 120, profile) {
  return runOpencli(['xiaohongshu', 'creator-notes-summary', '--limit', String(limit), '--timeout', '600', ...browserArgs], { timeoutMs: 660_000, profile });
}
function declarationArgs(task) {
  const desired = task.declarations;
  if (!desired) return [];
  const args = [];
  for (const [key, flag] of [['original', '--original'], ['aiGenerated', '--ai-declaration']]) {
    if (desired[key] == null) continue;
    if (typeof desired[key] !== 'boolean') throw new Error(`declarations.${key} must be a boolean`);
    args.push(flag, String(desired[key]));
  }
  return args;
}
export function publishArgs(task, { prepareOnly = false, keepTab = false } = {}) {
  const args = ['xiaohongshu', 'steward-publish', task.body, '--title', task.title];
  if (task.video) args.push('--video', task.video.path);
  else args.push('--images', task.images.map(image => image.path).join(','));
  if (task.cover) args.push('--cover', task.cover.path);
  args.push('--topics', task.topics.join(','), ...declarationArgs(task), ...(prepareOnly ? ['--prepare-only', 'true'] : []),
    ...(keepTab ? ['--window', 'background', '--keep-tab', 'true', '-f', 'json'] : browserArgs));
  return args;
}
export function editArgs(task, { prepareOnly = false, keepTab = false } = {}) {
  const args = ['xiaohongshu', 'edit-note', task.source_note_id, '--title', task.title,
    '--content', task.body, '--topics', task.topics.join(',')];
  if (task.images.length) args.push('--images', task.images.map(image => image.path).join(','));
  if (task.video) args.push('--video', task.video.path);
  if (task.cover) args.push('--cover', task.cover.path);
  if (process.env.XHS_OPS_COVER_TIMEOUT != null) {
    const seconds = Number(process.env.XHS_OPS_COVER_TIMEOUT);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) {
      throw new Error('XHS_OPS_COVER_TIMEOUT must be between 10 and 600 seconds');
    }
    args.push('--cover-timeout', String(seconds));
  }
  args.push(...declarationArgs(task), ...(prepareOnly ? ['--prepare-only', 'true'] : []),
    ...(keepTab ? ['--window', 'background', '--keep-tab', 'true', '-f', 'json'] : browserArgs));
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
