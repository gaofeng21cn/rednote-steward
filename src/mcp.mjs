#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Controller } from './lib/controller.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const home = path.resolve(process.env.XHS_OPS_HOME || path.join(os.homedir(), '.local/share/rednote-steward'));
const server = new McpServer({ name: 'rednote-steward', version: metadata.version }, {
  instructions: 'Manage Xiaohongshu through one local queue. Bind the intended account before writing. Apply the user\'s existing authorization, including batch or standing instructions. Inspect and ingest packages, authorize the chosen tasks, then execute. Execution returns a task ID; poll task_get. Reconcile an unknown result against the platform before retrying. Configuration and inspection requests alone do not authorize publication.',
});

const account = z.string().min(1).describe('Local account alias bound to a stable platform user ID and Chrome profile.');
const taskId = z.string().regex(/^xhs_[a-f0-9]+$/).describe('Task ID returned by package_ingest.');
const noteId = z.string().regex(/^[a-f0-9]{24}$/i);
const packagePath = z.string().refine(path.isAbsolute, 'Use an absolute local path.');
const limit = z.number().int().min(1).max(1000).default(30);
const batchId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const workerController = new Controller();
const result = (data, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: Array.isArray(data) ? { items: data } : data,
  ...(isError ? { isError: true } : {}),
});

async function callCli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
      env: process.env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout?.trim()) {
      try {
        return { ...JSON.parse(error.stdout), ok: false };
      } catch { /* Preserve the process error if stdout was not JSON. */ }
    }
    throw new Error(error.killed
      ? 'Command timed out. Inspect the task state before retrying.'
      : error.stderr?.trim() || error.message);
  }
}

function tool(name, description, inputSchema, execute, { readOnly = true, browser = false } = {}) {
  server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && browser,
      idempotentHint: readOnly, openWorldHint: browser },
  }, async (input) => {
    try {
      const value = await execute(input);
      return result(value, value?.ok === false);
    } catch (error) {
      return result({ ok: false, error: error.message }, true);
    }
  });
}

async function startTaskWorker(taskId, { prepareOnly = false } = {}) {
  const current = await callCli(['show', taskId]);
  if (!current.ok || !current.task) return current;
  if (current.task.state !== 'queued') return {
    ok: false, taskId, state: current.task.state, error: 'Only queued tasks execute. Reconcile unresolved attempts first.',
  };
  const logDir = path.join(home, 'workers');
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${taskId}-${Date.now()}.log`);
  const log = await fs.open(logPath, 'wx', 0o600);
  workerController.recordWorkerLaunch(taskId, { log: logPath, status: 'starting' });
  try {
    const child = spawn(process.execPath, [cli, 'worker-run', taskId, '--log', logPath, ...(prepareOnly ? ['--prepare-only'] : [])], {
      env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    workerController.recordWorkerLaunch(taskId, { pid: child.pid, log: logPath, status: 'started' });
    child.unref();
    return { ok: true, taskId, status: 'worker_started', workerPid: child.pid, log: logPath, prepareOnly,
      message: 'Use task_get to read the task outcome. Worker start is not platform submission.' };
  } catch (error) {
    workerController.recordWorkerLaunch(taskId, { log: logPath, status: 'failed', error: error.message });
    throw error;
  } finally { await log.close(); }
}

tool('accounts_list', 'List locally configured accounts and browser profile bindings.', {}, () => callCli(['account', 'list']));
tool('account_probe', 'Read the logged-in account stable ID from the selected Chrome profile.', {
  profile: z.string().min(1),
}, ({ profile }) => callCli(['account', 'probe', '--profile', profile]), { browser: true });
tool('account_bind', 'Save a local account binding. This configures an account; it does not publish.', {
  account, userId: z.string().min(1), profile: z.string().min(1), name: z.string().optional(),
}, ({ account, userId, profile, name }) => callCli([
  'account', 'add', account, '--user-id', userId, '--profile', profile,
  ...(name ? ['--name', name] : []),
]), { readOnly: false });
tool('doctor', 'Check the local installation and browser connection; optionally verify a bound account.', {
  account: account.optional(), redact: z.boolean().default(false),
}, ({ account, redact }) => callCli(['doctor', ...(account ? ['--account', account] : []), ...(redact ? ['--redact'] : [])]), { browser: true });
tool('account_status', 'Read local bindings and same-machine owner conflicts without a browser call.', { account: account.optional() },
  ({ account }) => callCli(['account', 'status', ...(account ? [account] : [])]));
tool('notes_list', 'Read the account creator inventory.', { account, limit },
  ({ account, limit }) => callCli(['inventory', '--account', account, '--limit', String(limit)]), { browser: true });
tool('note_get', 'Read the same platform note title, body, native topics and exposed media fields.', {
  account, noteId, noteType: z.enum(['normal', 'video']).default('normal'),
}, ({ account, noteId, noteType }) => callCli(['note', noteId, '--account', account, '--note-type', noteType]), { browser: true });
tool('package_inspect', 'Validate a local image or video package and calculate its content fingerprint.', { path: packagePath },
  ({ path }) => callCli(['inspect', path, '--json']));
tool('package_ingest', 'Import a local package as a draft task. Duplicate content is detected.', { path: packagePath },
  ({ path }) => callCli(['ingest', path]), { readOnly: false });
tool('packages_ingest', 'Import an explicit set of packages into one batch. Existing tasks remain linked through duplicate detection.', {
  paths: z.array(packagePath).min(1).max(1000), batchId: batchId.optional(), dryRun: z.boolean().default(false),
}, ({ paths, batchId, dryRun }) => callCli(['ingest-batch', ...paths, ...(batchId ? ['--batch', batchId] : []), ...(dryRun ? ['--dry-run'] : [])]), { readOnly: false });
tool('tasks_list', 'List tasks, eligibility and blockers in the shared queue.', { account: account.optional(), batchId: batchId.optional(), all: z.boolean().default(false) },
  ({ account, batchId, all }) => callCli(['plan', ...(account ? ['--account', account] : []), ...(batchId ? ['--batch', batchId] : []), ...(all ? ['--all'] : [])]));
tool('task_review', 'Read exact task content, frozen media, field differences and owner readback without a browser call or publication.', {
  taskId: taskId.optional(), account: account.optional(), fingerprint: z.string().optional(), revision: z.string().optional(),
}, ({ taskId, account, fingerprint, revision }) => callCli(['review', ...(taskId ? [taskId] : []),
  ...(account ? ['--account', account] : []), ...(fingerprint ? ['--fingerprint', fingerprint] : []), ...(revision ? ['--revision', revision] : [])]));
tool('task_get', 'Read task status, attempt history and platform readback. Use after task_execute.', { taskId },
  ({ taskId }) => callCli(['show', taskId]));
tool('task_authorize', 'Record existing user authorization and queue this task. A batch instruction may cover multiple tasks.', {
  taskId, authorization: z.string().min(1).describe('The applicable user instruction or authorization reference.'),
  at: z.iso.datetime({ offset: true }).optional(),
  fingerprint: z.string().optional().describe('Expected content fingerprint from task_review.'),
  revision: z.string().optional().describe('Expected task revision from task_review; a changed task requires reopening.'),
}, ({ taskId, authorization, at, fingerprint, revision }) => callCli([
  'approve', taskId, '--authorization', authorization, ...(at ? ['--at', at] : ['--now']),
  ...(fingerprint ? ['--fingerprint', fingerprint] : []), ...(revision ? ['--revision', revision] : []),
]), { readOnly: false });
tool('batch_authorize', 'Record one existing user instruction for the frozen tasks in a batch.', {
  batchId, authorization: z.string().min(1), at: z.iso.datetime({ offset: true }).optional(),
}, ({ batchId, authorization, at }) => callCli(['approve-batch', batchId, '--authorization', authorization, ...(at ? ['--at', at] : ['--now'])]), { readOnly: false });
tool('task_cancel', 'Cancel an unstarted task; an unresolved platform write must be reconciled instead.', {
  taskId, reason: z.string().min(1).optional(),
}, ({ taskId, reason }) => callCli(['cancel', taskId, ...(reason ? ['--reason', reason] : [])]), { readOnly: false });
tool('queue_pause', 'Pause queued tasks for an account or batch. Active writes continue to their safe outcome.', {
  account: account.optional(), batchId: batchId.optional(), reason: z.string().optional(),
}, ({ account, batchId, reason }) => callCli(['pause', ...(account ? ['--account', account] : []), ...(batchId ? ['--batch', batchId] : []), ...(reason ? ['--reason', reason] : [])]), { readOnly: false });
tool('queue_resume', 'Resume paused tasks for an account or batch under their existing authorization.', {
  account: account.optional(), batchId: batchId.optional(),
}, ({ account, batchId }) => callCli(['resume', ...(account ? ['--account', account] : []), ...(batchId ? ['--batch', batchId] : [])]), { readOnly: false });
tool('task_execute', 'Start one authorized task in a separate worker. Returns immediately; use task_get for the outcome.', {
  taskId,
}, ({ taskId }) => startTaskWorker(taskId), { readOnly: false, browser: true });
tool('task_reconcile', 'Read platform state to resolve an interrupted or uncertain attempt. This never submits a post.', {
  taskId, noteId: noteId.optional(), absent: z.boolean().default(false), reason: z.string().optional(),
}, ({ taskId, noteId, absent, reason }) => callCli([
  'reconcile', taskId, ...(noteId ? ['--note-id', noteId] : []),
  ...(absent ? ['--absent'] : []), ...(reason ? ['--reason', reason] : []),
]), { readOnly: false, browser: true });
tool('task_handoff', 'Read a frozen task handoff with last phase, intended fields and manual recovery instructions.', { taskId },
  ({ taskId }) => callCli(['handoff', taskId]));
tool('task_prepare', 'Fill and inspect one authorized task without submitting it. Prepared state still requires recovery against the retained composer.', { taskId },
  ({ taskId }) => startTaskWorker(taskId, { prepareOnly: true }), { readOnly: false, browser: true });
tool('task_link_existing', 'Read and link an existing platform note after manual publication. This does not submit a new post.', {
  taskId, noteId, reason: z.string().min(1), coverEvidence: packagePath.optional(),
}, ({ taskId, noteId, reason, coverEvidence }) => callCli(['link-existing', taskId, '--note-id', noteId, '--reason', reason, ...(coverEvidence ? ['--cover-evidence', coverEvidence] : [])]), { readOnly: false, browser: true });
tool('cover_evidence', 'Recompute cover content evidence bound to one frozen task and the current same-note cover. This does not publish.', {
  taskId, noteId, platformCover: packagePath, output: packagePath,
}, ({ taskId, noteId, platformCover, output }) => callCli(['cover-evidence', taskId, '--note-id', noteId, '--platform-cover', platformCover, '--output', output]), { readOnly: false, browser: true });
tool('task_supersede', 'Retire a historical task in favor of a verified replacement for the same account and note, preserving its unverified history.', {
  taskId, replacementTaskId: taskId, reason: z.string().min(1),
}, ({ taskId, replacementTaskId, reason }) => callCli(['supersede', taskId, '--replacement-task', replacementTaskId, '--reason', reason]), { readOnly: false, browser: true });
tool('metrics_collect', 'Read account metrics into the local account history.', { account, limit },
  ({ account, limit }) => callCli(['collect', '--account', account, '--limit', String(limit)]), { readOnly: false, browser: true });
tool('metrics_history', 'Read append-only observations for an account and optional note. Missing metrics remain distinct from zero.', {
  account, noteId: noteId.optional(), limit,
}, ({ account, noteId, limit }) => callCli(['metrics-history', '--account', account, ...(noteId ? ['--note-id', noteId] : []), '--limit', String(limit)]));
tool('catalog_list', 'Read local account assets, series and maintenance status without creating publication tasks.', {
  account: account.optional(), seriesId: z.string().optional(), status: z.string().optional(), limit,
}, ({ account, seriesId, status, limit }) => callCli(['catalog', ...(account ? ['--account', account] : []), ...(seriesId ? ['--series', seriesId] : []), ...(status ? ['--status', status] : []), '--limit', String(limit)]));
tool('catalog_sync', 'Read creator inventory into the local asset map without editing or publishing platform posts.', { account, limit },
  ({ account, limit }) => callCli(['catalog', 'sync', '--account', account, '--limit', String(limit)]), { readOnly: false, browser: true });
tool('catalog_update', 'Record local series, content type or maintenance judgment for an existing platform note.', {
  account, noteId, seriesId: z.string().optional(), episode: z.string().optional(), contentType: z.string().optional(),
  maintenanceStatus: z.enum(['unreviewed','keep','needs_fact_check','needs_copy','needs_media','updated','waiting_evidence','video_pending']).optional(),
  reason: z.string().optional(), sourcePath: packagePath.optional(),
}, ({ account, noteId, seriesId, episode, contentType, maintenanceStatus, reason, sourcePath }) => callCli(['catalog','set',noteId,'--account',account,
  ...(seriesId ? ['--series',seriesId] : []), ...(episode ? ['--episode',episode] : []), ...(contentType ? ['--content-type',contentType] : []),
  ...(maintenanceStatus ? ['--maintenance-status',maintenanceStatus] : []), ...(reason ? ['--reason',reason] : []), ...(sourcePath ? ['--source',sourcePath] : [])]), { readOnly: false });
tool('series_list', 'Read local series, expected episodes, platform notes and prepared tasks.', { account, seriesId: z.string().optional() },
  ({ account, seriesId }) => callCli(['catalog','series','--account',account,...(seriesId ? ['--series',seriesId] : [])]));
tool('series_define', 'Define a local content series and its expected episode labels. This creates no publication task.', {
  account, seriesId: z.string().min(1), title: z.string().min(1), description: z.string().optional(), expectedEpisodes: z.array(z.string()).default([]),
}, ({ account, seriesId, title, description, expectedEpisodes }) => callCli(['catalog','series','--account',account,'--series',seriesId,'--title',title,
  ...(description ? ['--description',description] : []), ...(expectedEpisodes.length ? ['--episodes', expectedEpisodes.join(',')] : [])]), { readOnly: false });
tool('account_policy', 'Read or update a private account inspection brief. Policy settings never create a recurring schedule.', {
  account, policy: z.record(z.string(), z.unknown()).optional(),
}, ({ account, policy }) => callCli(['catalog','policy','--account',account,...(policy ? ['--file',JSON.stringify(policy)] : [])]), { readOnly: false });
tool('inspection_candidates', 'Read incremental local maintenance candidates while retaining mature content and explicit keep decisions.', {
  account, limit: z.number().int().min(1).max(100).default(6),
}, ({ account, limit }) => callCli(['catalog','inspection','--account',account,'--limit',String(limit)]));
tool('inspection_cursor', 'Read or advance the local inspection watermark after the selected notes have been checked.', {
  account, watermark: z.iso.datetime({ offset: true }).optional(), boundaryNoteIds: z.array(noteId).default([]),
}, ({ account, watermark, boundaryNoteIds }) => callCli(['catalog','cursor','--account',account,
  ...(watermark ? ['--watermark',watermark] : []), ...(boundaryNoteIds.length ? ['--boundary',boundaryNoteIds.join(',')] : [])]), { readOnly: false });
tool('state_backup', 'Create an online SQLite snapshot with selected configuration and receipts. Browser cookies and media bytes are excluded.', { destination: packagePath },
  ({ destination }) => callCli(['backup','--out',destination]), { readOnly: false });
tool('state_restore', 'Preview or restore a backup into an empty state directory. Application is explicit; no post is submitted.', {
  backupPath: packagePath, target: packagePath.optional(), pathMappings: z.array(z.object({ from: packagePath, to: packagePath })).default([]), apply: z.boolean().default(false),
}, ({ backupPath, target, pathMappings, apply }) => callCli(['restore',backupPath,...(target ? ['--target',target] : []),
  '--path-mappings',JSON.stringify(pathMappings),...(apply ? ['--apply'] : [])]), { readOnly: false });
tool('legacy_import', 'Preview or explicitly import a known legacy ledger as history. Imported unresolved records stay blocked and nothing is auto-published.', {
  source: packagePath, account, sourceAccount: z.string().optional(), target: packagePath.optional(),
  pathMappings: z.array(z.object({ from: packagePath, to: packagePath })).default([]), expectedDigest: z.string().optional(), apply: z.boolean().default(false),
}, ({ source, account, sourceAccount, target, pathMappings, expectedDigest, apply }) => callCli(['import-legacy',source,'--account',account,
  ...(sourceAccount ? ['--source-account',sourceAccount] : []),...(target ? ['--target',target] : []), '--path-mappings',JSON.stringify(pathMappings),
  ...(expectedDigest ? ['--expected-digest',expectedDigest] : []),...(apply ? ['--apply'] : [])]), { readOnly: false });
tool('media_info', 'Inspect local dimensions, container and optional ffprobe streams without altering approved media.', {
  path: packagePath, ffprobe: z.boolean().default(false),
}, ({ path, ffprobe }) => callCli(['media-info',path,...(ffprobe ? ['--ffprobe'] : [])]));
tool('media_compare', 'Compare approved video bytes with a downloaded platform readback using full-duration visual, audio and duration checks.', {
  localPath: packagePath,
  platformPath: packagePath,
  ssimThreshold: z.number().min(0).max(1).default(0.995),
  audioPsnrThreshold: z.number().min(0).default(30),
  durationTolerance: z.number().min(0).default(0.25),
  evidenceDirectory: packagePath.optional(),
}, ({ localPath, platformPath, ssimThreshold, audioPsnrThreshold, durationTolerance, evidenceDirectory }) => callCli([
  'media-compare', localPath, platformPath,
  '--ssim-threshold', String(ssimThreshold),
  '--audio-psnr-threshold', String(audioPsnrThreshold),
  '--duration-tolerance', String(durationTolerance),
  ...(evidenceDirectory ? ['--evidence-dir', evidenceDirectory] : []),
]));
tool('backend_qualify', 'Benchmark read-only identity and inventory probes for the explicitly selected local backend. Publishing capabilities remain untested.', {
  account, backendLabel: z.string().default('bundled'), repeats: z.number().int().min(1).max(20).default(3), limit,
}, ({ account, backendLabel, repeats, limit }) => callCli(['qualify','--account',account,'--backend-label',backendLabel,'--repeats',String(repeats),'--limit',String(limit)]), { readOnly: false, browser: true });
tool('backend_compare', 'Compare saved read-only backend qualification receipts for the same hashed account/profile.', {
  paths: z.array(packagePath).min(2).max(20),
}, ({ paths }) => callCli(['compare-qualifications',...paths]));
tool('queue_execute', 'Execute due authorized tasks for one bounded batch or account. A blocked account does not stop other eligible accounts.', {
  account: account.optional(), batchId: batchId.optional(), limit: z.number().int().min(1).max(1000).default(10),
}, async ({ account, batchId, limit }) => {
  if (!account && !batchId) throw new Error('queue_execute requires account or batchId');
  const plan = workerController.plan({ account, batchId });
  const intended = plan.tasks.filter(task => task.execution?.eligible).slice(0, limit);
  if (!intended.length) return { ok: true, executed: [], message: 'No due eligible task in this selection' };
  const logDir = path.join(home, 'workers');
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `batch-${Date.now()}.log`);
  const log = await fs.open(logPath, 'wx', 0o600);
  try {
    const child = spawn(process.execPath, [cli, 'worker-batch', ...(batchId ? ['--batch', batchId] : []),
      ...(account ? ['--account', account] : []), '--limit', String(limit), '--log', logPath], {
      env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true, status: 'worker_started', account, batchId, workerPid: child.pid, log: logPath,
      taskIds: intended.map(task => task.id), message: 'Use tasks_list and task_get for per-task outcomes; start is not submission.' };
  } finally { await log.close(); }
}, { readOnly: false, browser: true });
tool('account_audit', 'Read metrics and surface review candidates for the requested account.', { account, limit },
  ({ account, limit }) => callCli(['audit', '--account', account, '--limit', String(limit)]), { browser: true });

server.registerResource('capabilities', 'rednote://capabilities', {
  description: 'RedNote Steward entry points and operating boundaries.', mimeType: 'application/json',
}, async () => ({ contents: [{ uri: 'rednote://capabilities', mimeType: 'application/json', text: JSON.stringify({
  version: metadata.version, transport: 'stdio', platform: 'xiaohongshu',
  backend: 'OpenCLI 1.8.5 + logged-in Chrome',
  state: 'CLI and MCP share the same local account database, including batch, phase, handoff, catalog and metric history projections.',
  scheduling: 'Queued due times; execution is invoked by the user or their explicitly configured scheduler.',
  ui: 'Read-only task, content and media views use the OPL shared MCP App when this Package is discovered by its host. task_review and xhs-ops review return the same owner data without a UI.',
  publicationEvidence: 'Submission, field verification, platform review and reach are separate outcomes. Manual publication can be linked to the original task after same-note readback.',
}) }] }));

await server.connect(new StdioServerTransport());
