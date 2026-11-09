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
  account: account.optional(),
}, ({ account }) => callCli(['doctor', ...(account ? ['--account', account] : [])]), { browser: true });
tool('notes_list', 'Read the account creator inventory.', { account, limit },
  ({ account, limit }) => callCli(['inventory', '--account', account, '--limit', String(limit)]), { browser: true });
tool('note_get', 'Read the same platform note title, body, native topics and exposed media fields.', { account, noteId },
  ({ account, noteId }) => callCli(['note', noteId, '--account', account]), { browser: true });
tool('package_inspect', 'Validate a local image or video package and calculate its content fingerprint.', { path: packagePath },
  ({ path }) => callCli(['inspect', path, '--json']));
tool('package_ingest', 'Import a local package as a draft task. Duplicate content is detected.', { path: packagePath },
  ({ path }) => callCli(['ingest', path]), { readOnly: false });
tool('tasks_list', 'List draft, queued and unresolved tasks.', { account: account.optional() },
  ({ account }) => callCli(['plan', ...(account ? ['--account', account] : [])]));
tool('task_get', 'Read task status, attempt history and platform readback. Use after task_execute.', { taskId },
  ({ taskId }) => callCli(['show', taskId]));
tool('task_authorize', 'Record existing user authorization and queue this task. A batch instruction may cover multiple tasks.', {
  taskId, authorization: z.string().min(1).describe('The applicable user instruction or authorization reference.'),
  at: z.iso.datetime({ offset: true }).optional(),
}, ({ taskId, authorization, at }) => callCli([
  'approve', taskId, '--authorization', authorization, ...(at ? ['--at', at] : ['--now']),
]), { readOnly: false });
tool('task_execute', 'Start one authorized task in a separate worker. Returns immediately; use task_get for the outcome.', {
  taskId,
}, async ({ taskId }) => {
  const current = await callCli(['show', taskId]);
  if (!current.ok || !current.task) return current;
  if (current.task.state !== 'queued') return {
    ok: false, taskId, state: current.task.state, error: 'Only queued tasks execute. Reconcile unresolved attempts first.',
  };
  const logDir = path.join(home, 'workers');
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${taskId}-${Date.now()}.log`);
  const log = await fs.open(logPath, 'wx', 0o600);
  try {
    const child = spawn(process.execPath, [cli, 'run', taskId], {
      env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true, taskId, status: 'worker_started', workerPid: child.pid,
      message: 'Use task_get to read the task outcome. Worker start is not platform submission.' };
  } finally {
    await log.close();
  }
}, { readOnly: false, browser: true });
tool('task_reconcile', 'Read platform state to resolve an interrupted or uncertain attempt. This never submits a post.', {
  taskId, noteId: noteId.optional(), absent: z.boolean().default(false), reason: z.string().optional(),
}, ({ taskId, noteId, absent, reason }) => callCli([
  'reconcile', taskId, ...(noteId ? ['--note-id', noteId] : []),
  ...(absent ? ['--absent'] : []), ...(reason ? ['--reason', reason] : []),
]), { readOnly: false, browser: true });
tool('metrics_collect', 'Read account metrics into the local account history.', { account, limit },
  ({ account, limit }) => callCli(['collect', '--account', account, '--limit', String(limit)]), { readOnly: false, browser: true });
tool('account_audit', 'Read metrics and surface review candidates for the requested account.', { account, limit },
  ({ account, limit }) => callCli(['audit', '--account', account, '--limit', String(limit)]), { browser: true });

server.registerResource('capabilities', 'rednote://capabilities', {
  description: 'RedNote Steward entry points and operating boundaries.', mimeType: 'application/json',
}, async () => ({ contents: [{ uri: 'rednote://capabilities', mimeType: 'application/json', text: JSON.stringify({
  version: metadata.version, transport: 'stdio', platform: 'xiaohongshu',
  backend: 'OpenCLI 1.8.5 + logged-in Chrome',
  state: 'CLI and MCP share the same local account database.',
  scheduling: 'Queued due times; execution is invoked by the user or their explicitly configured scheduler.',
  ui: 'Structured tools; a graphical MCP App is not included in this release.',
  publicationEvidence: 'Submission, field verification, platform review and reach are separate outcomes.',
}) }] }));

await server.connect(new StdioServerTransport());
