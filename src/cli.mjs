#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from './lib/controller.mjs';
import { addAccount, listAccounts, stateRoot, getAccount } from './lib/config.mjs';
import { inspectPackage } from './lib/package.mjs';
import { readAccount, rowOf, runOpencli, verifiedIdentity } from './lib/opencli.mjs';
import { createReviewWorkspace } from './lib/workspace.mjs';

function parseArgs(argv) {
  const positionals = [], options = {};
  const flags = new Set(['json','help','dry-run','now','all','absent','repair','skill','mcp','skip-integrations','skip-browser-setup','status','uninstall','browser-extension']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const separator = token.indexOf('=');
    const key = token.slice(2, separator < 0 ? undefined : separator);
    if (separator >= 0) { options[key] = token.slice(separator + 1); continue; }
    if (flags.has(key)) { options[key] = true; continue; }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`);
    options[key] = next; index++;
  }
  return { positionals, options };
}
function integer(value, fallback, max = 10000) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`Expected an integer between 1 and ${max}`);
  return number;
}
function requireValue(value, usage) { if (!value) throw new Error(`Usage: xhs-ops ${usage}`); return value; }
function help() {
  return `RedNote Steward — Xiaohongshu publishing and account operations

Usage:
  xhs-ops setup [--repair] [--skip-integrations] [--skip-browser-setup]
  xhs-ops init
  xhs-ops doctor [--account ALIAS]
  xhs-ops opencli <args...>
  xhs-ops account probe --profile PROFILE
  xhs-ops account add ALIAS --user-id ID --profile PROFILE [--name NAME]
  xhs-ops account list
  xhs-ops inventory --account ALIAS [--limit 100]
  xhs-ops note NOTE_ID --account ALIAS
  xhs-ops inspect PACKAGE
  xhs-ops ingest PACKAGE [--dry-run]
  xhs-ops approve TASK_ID [--authorization TEXT] [--at ISO8601|--now]
  xhs-ops plan [--account ALIAS] [--all]
  xhs-ops review [TASK_ID] [--account ALIAS] [--fingerprint HASH] [--revision REVISION]
  xhs-ops show TASK_ID
  xhs-ops run [TASK_ID] [--dry-run]
  xhs-ops reconcile TASK_ID [--note-id ID] [--absent --reason TEXT]
  xhs-ops collect --account ALIAS [--limit 120]
  xhs-ops audit --account ALIAS [--limit 120]
  xhs-ops scaffold AUDIT_JSON --out DIRECTORY [--limit 4]
  xhs-ops report [--account ALIAS] [--limit 50]

Commands return JSON. The host may record an existing batch or standing
publication authorization; approval does not require a new user interaction.
Unknown submissions must be reconciled before another account write.
XHS_OPS_HOME selects the private data directory (default ~/.local/share/rednote-steward).
`;
}
export async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  if (['opencli', 'browser'].includes(command)) {
    const result = await runOpencli(command === 'browser' ? ['browser', ...rest] : rest, { timeoutMs: 1_200_000 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.exitCode === 0 ? 0 : 1;
    return;
  }
  if (command === '--version' || command === 'version') {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`); return;
  }
  const { positionals, options } = parseArgs(rest);
  if (command === 'help' || command === '--help' || options.help) { process.stdout.write(help()); return; }
  const controller = new Controller();
  let result;
  if (command === 'setup') {
    const { setup } = await import('./setup.mjs'); result = await setup(options);
  } else if (command === 'init') result = controller.init();
  else if (command === 'account') {
    const [subcommand = 'list', alias] = positionals;
    if (subcommand === 'list') result = { ok: true, accounts: listAccounts() };
    else if (subcommand === 'add') result = { ok: true, account: addAccount({ alias, userId: options['user-id'], profile: options.profile, name: options.name }) };
    else if (['probe', 'discover'].includes(subcommand)) {
      const profile = requireValue(options.profile, 'account probe --profile PROFILE');
      const response = await readAccount(profile);
      const identity = rowOf(response.json);
      result = { ok: response.exitCode === 0 && identity?.logged_in === true && Boolean(identity.userId), profile, identity, error: response.exitCode === 0 ? undefined : response.stderr.trim() };
    } else throw new Error(`Unknown account command: ${subcommand}`);
  } else if (command === 'doctor') {
    const checks = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version }];
    checks.push({ name: 'private-data', ok: true, detail: stateRoot() });
    // Diagnosis does not initialize a task database or create a second queue.
    const response = await runOpencli(['doctor'], { timeoutMs: 60_000 });
    checks.push({ name: 'opencli', ok: response.exitCode === 0, detail: response.json ?? response.stdout.trim() ?? response.stderr.trim() });
    if (options.account) {
      try { checks.push({ name: 'account', ok: true, detail: await verifiedIdentity(getAccount(options.account)) }); }
      catch (error) { checks.push({ name: 'account', ok: false, detail: error.message }); }
    }
    result = { ok: checks.every(check => check.ok), checks };
  } else if (command === 'inventory') result = await controller.inventory(requireValue(options.account, 'inventory --account ALIAS'), integer(options.limit, 100));
  else if (command === 'note') result = await controller.note(requireValue(options.account, 'note NOTE_ID --account ALIAS'), requireValue(positionals[0], 'note NOTE_ID --account ALIAS'));
  else if (command === 'inspect') result = { ok: true, package: await inspectPackage(requireValue(positionals[0], 'inspect PACKAGE')) };
  else if (command === 'ingest') result = await controller.ingest(requireValue(positionals[0], 'ingest PACKAGE'), { dryRun: Boolean(options['dry-run']) });
  else if (['approve', 'authorize'].includes(command)) result = controller.approve(requireValue(positionals[0], 'approve TASK_ID'), { at: options.now ? new Date().toISOString() : options.at, authorization: options.authorization, fingerprint: options.fingerprint, revision: options.revision });
  else if (command === 'plan') result = controller.plan({ account: options.account, all: Boolean(options.all) });
  else if (command === 'review') result = await controller.review({ taskId: positionals[0], account: options.account, fingerprint: options.fingerprint, revision: options.revision });
  else if (command === 'show') result = controller.show(requireValue(positionals[0], 'show TASK_ID'));
  else if (command === 'run') result = await controller.execute(positionals[0], { dryRun: Boolean(options['dry-run']) });
  else if (['reconcile', 'recover'].includes(command)) result = await controller.reconcile(requireValue(positionals[0], 'reconcile TASK_ID'), { noteId: options['note-id'], absent: Boolean(options.absent), reason: options.reason });
  else if (['collect', 'audit'].includes(command)) result = await controller.collect(requireValue(options.account, `${command} --account ALIAS`), integer(options.limit, 120), { audit: command === 'audit' });
  else if (command === 'report') result = controller.report({ account: options.account, limit: integer(options.limit, 50) });
  else if (command === 'scaffold') {
    const input = requireValue(positionals[0], 'scaffold AUDIT_JSON --out DIRECTORY');
    const audit = JSON.parse(await fs.readFile(input, 'utf8'));
    if (!Array.isArray(audit.candidates)) throw new Error('Audit JSON must contain candidates');
    const root = path.resolve(requireValue(options.out, 'scaffold AUDIT_JSON --out DIRECTORY'));
    const created = [];
    for (const row of audit.candidates.slice(0, integer(options.limit, 4))) created.push(await createReviewWorkspace({ root, row, existingNoteId: row.id }));
    result = { ok: true, root, created };
  } else throw new Error(`Unknown command: ${command}; run xhs-ops help`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result?.ok === false) process.exitCode = 1;
  return result;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; });
}
