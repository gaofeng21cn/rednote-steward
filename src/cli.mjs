#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from './lib/controller.mjs';
import { addAccount, listAccounts, stateRoot, getAccount, transferAccountBinding } from './lib/config.mjs';
import { inspectPackage } from './lib/package.mjs';
import { readAccount, rowOf, runOpencli, verifiedIdentity } from './lib/opencli.mjs';
import { createReviewWorkspace } from './lib/workspace.mjs';
import { diagnose, redactHealth } from './lib/health.mjs';
import { inspectAccountOwner } from './lib/owner.mjs';
import { createBackup, previewRestore, restoreBackup } from './lib/backup.mjs';
import { previewLegacyImport, applyLegacyImport } from './lib/migration.mjs';
import { inspectMediaMetadata } from './lib/lineage.mjs';

function parseArgs(argv, command) {
  const positionals = [], options = {};
  const flags = new Set(['json','help','dry-run','now','all','absent','repair','skill','mcp','skip-integrations','skip-browser-setup','status','uninstall','browser-extension','redact','prepare-only','apply','ffprobe']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const separator = token.indexOf('=');
    const key = token.slice(2, separator < 0 ? undefined : separator);
    if (separator >= 0) { options[key] = token.slice(separator + 1); continue; }
    if (flags.has(key) && !(key === 'status' && command !== 'setup')) { options[key] = true; continue; }
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
async function jsonOption(value, label, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { /* A file path is also accepted. */ }
  try { return JSON.parse(await fs.readFile(path.resolve(value), 'utf8')); }
  catch (error) { throw new Error(`${label} must be JSON or a readable JSON file: ${error.message}`); }
}
function help() {
  return `RedNote Steward — Xiaohongshu publishing and account operations

Usage:
  xhs-ops setup [--repair] [--skip-integrations] [--skip-browser-setup]
  xhs-ops init
  xhs-ops doctor [--account ALIAS] [--redact]
  xhs-ops opencli <args...>
  xhs-ops account probe --profile PROFILE
  xhs-ops account add ALIAS --user-id ID --profile PROFILE [--name NAME]
  xhs-ops account list
  xhs-ops account status [ALIAS]
  xhs-ops account takeover ALIAS --user-id ID --profile PROFILE --from-home DIRECTORY --reason TEXT
  xhs-ops inventory --account ALIAS [--limit 1000]
  xhs-ops note NOTE_ID --account ALIAS [--note-type video]
  xhs-ops inspect PACKAGE
  xhs-ops ingest PACKAGE [--dry-run]
  xhs-ops ingest-batch PACKAGE... [--batch BATCH_ID] [--dry-run]
  xhs-ops approve TASK_ID [--authorization TEXT] [--at ISO8601|--now]
  xhs-ops approve-batch BATCH_ID [--authorization TEXT] [--at ISO8601|--now]
  xhs-ops plan [--account ALIAS] [--all]
  xhs-ops review [TASK_ID] [--account ALIAS] [--fingerprint HASH] [--revision REVISION]
  xhs-ops show TASK_ID
  xhs-ops run [TASK_ID] [--dry-run]
  xhs-ops prepare TASK_ID
  xhs-ops run-batch BATCH_ID [--account ALIAS] [--limit N]
  xhs-ops cancel TASK_ID [--reason TEXT]
  xhs-ops pause [--account ALIAS] [--batch BATCH_ID] [--reason TEXT]
  xhs-ops resume [--account ALIAS] [--batch BATCH_ID]
  xhs-ops reconcile TASK_ID [--note-id ID] [--absent --reason TEXT]
  xhs-ops handoff TASK_ID
  xhs-ops link-existing TASK_ID --note-id NOTE_ID [--reason TEXT]
  xhs-ops collect --account ALIAS [--limit 120]
  xhs-ops metrics-history --account ALIAS [--note-id NOTE_ID] [--limit 50]
  xhs-ops catalog [--account ALIAS] [--series SERIES_ID] [--status STATUS] [--limit 100]
  xhs-ops catalog sync --account ALIAS [--limit 100]
  xhs-ops catalog set NOTE_ID --account ALIAS [--series ID] [--episode LABEL] [--content-type TYPE] [--maintenance-status STATUS] [--reason TEXT]
  xhs-ops catalog series --account ALIAS [--series ID] [--title TEXT --episodes 01,02]
  xhs-ops catalog policy --account ALIAS [--file POLICY_JSON]
  xhs-ops catalog cursor --account ALIAS [--watermark ISO8601 --boundary NOTE_ID,...]
  xhs-ops catalog inspection --account ALIAS [--limit 6]
  xhs-ops backup --out DIRECTORY
  xhs-ops restore BACKUP_DIRECTORY [--target EMPTY_DIRECTORY] [--path-mappings JSON] [--apply]
  xhs-ops import-legacy SOURCE --account ALIAS [--source-account OLD_ALIAS] [--target DIRECTORY] [--path-mappings JSON] [--expected-digest HASH --apply]
  xhs-ops media-info FILE [--ffprobe]
  xhs-ops qualify --account ALIAS [--backend-label LABEL] [--repeats N] [--limit N]
  xhs-ops compare-qualifications FILE...
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
  const { positionals, options } = parseArgs(rest, command);
  if (command === 'help' || command === '--help' || options.help) { process.stdout.write(help()); return; }
  const controller = new Controller();
  let result;
  if (command === 'setup') {
    const { setup } = await import('./setup.mjs'); result = await setup(options);
  } else if (command === 'init') result = controller.init();
  else if (command === 'account') {
    const [subcommand = 'list', alias] = positionals;
    if (subcommand === 'list') result = { ok: true, accounts: listAccounts() };
    else if (subcommand === 'status') {
      const accounts = alias ? [getAccount(alias)] : listAccounts();
      result = { ok: true, accounts: accounts.map(item => ({ ...item, owner: inspectAccountOwner(item) })) };
    }
    else if (subcommand === 'takeover') {
      const existing = listAccounts().find(item => item.alias === alias);
      const binding = { alias, userId: options['user-id'] ?? existing?.userId,
        profile: options.profile ?? existing?.profile, name: options.name ?? existing?.name ?? '' };
      result = { ok: true, ...transferAccountBinding(binding, {
        fromHome: requireValue(options['from-home'], 'account takeover ALIAS --from-home DIRECTORY --reason TEXT'),
        reason: requireValue(options.reason, 'account takeover ALIAS --from-home DIRECTORY --reason TEXT') }) };
    }
    else if (subcommand === 'add') result = { ok: true, account: addAccount({ alias, userId: options['user-id'], profile: options.profile, name: options.name }) };
    else if (['probe', 'discover'].includes(subcommand)) {
      const profile = requireValue(options.profile, 'account probe --profile PROFILE');
      const response = await readAccount(profile);
      const identity = rowOf(response.json);
      result = { ok: response.exitCode === 0 && identity?.logged_in === true && Boolean(identity.userId), profile, identity, error: response.exitCode === 0 ? undefined : response.stderr.trim() };
    } else throw new Error(`Unknown account command: ${subcommand}`);
  } else if (command === 'doctor') {
    const report = await diagnose({ accountAlias: options.account });
    result = options.redact ? redactHealth(report) : report;
  } else if (command === 'inventory') result = await controller.inventory(requireValue(options.account, 'inventory --account ALIAS'), integer(options.limit, 100));
  else if (command === 'note') result = await controller.note(requireValue(options.account, 'note NOTE_ID --account ALIAS'), requireValue(positionals[0], 'note NOTE_ID --account ALIAS'), options['note-type'] || 'normal');
  else if (command === 'inspect') result = { ok: true, package: await inspectPackage(requireValue(positionals[0], 'inspect PACKAGE')) };
  else if (command === 'ingest') result = await controller.ingest(requireValue(positionals[0], 'ingest PACKAGE'), { dryRun: Boolean(options['dry-run']), batchId: options.batch });
  else if (command === 'ingest-batch') {
    if (!positionals.length) throw new Error('Usage: xhs-ops ingest-batch PACKAGE...');
    result = await controller.ingestBatch(positionals, { batchId: options.batch, dryRun: Boolean(options['dry-run']) });
  }
  else if (['approve', 'authorize'].includes(command)) result = controller.approve(requireValue(positionals[0], 'approve TASK_ID'), { at: options.now ? new Date().toISOString() : options.at, authorization: options.authorization, fingerprint: options.fingerprint, revision: options.revision });
  else if (command === 'approve-batch') result = controller.approveBatch(requireValue(positionals[0], 'approve-batch BATCH_ID'), { at: options.now ? new Date().toISOString() : options.at, authorization: options.authorization });
  else if (command === 'plan') result = controller.plan({ account: options.account, batchId: options.batch, all: Boolean(options.all) });
  else if (command === 'review') result = await controller.review({ taskId: positionals[0], account: options.account, fingerprint: options.fingerprint, revision: options.revision });
  else if (command === 'show') result = controller.show(requireValue(positionals[0], 'show TASK_ID'));
  else if (command === 'run') result = await controller.execute(positionals[0], { dryRun: Boolean(options['dry-run']), account: options.account, batchId: options.batch });
  else if (command === 'prepare') result = await controller.prepare(requireValue(positionals[0], 'prepare TASK_ID'));
  else if (command === 'worker-run') {
    const id = requireValue(positionals[0], 'worker-run TASK_ID');
    try {
      result = options['prepare-only'] ? await controller.prepare(id) : await controller.execute(id);
      controller.recordWorkerLaunch(id, { pid: process.pid, log: options.log, status: result.ok ? 'finished' : 'failed', error: result.error });
    } catch (error) {
      controller.recordWorkerLaunch(id, { pid: process.pid, log: options.log, status: 'failed', error: error.message });
      throw error;
    }
  }
  else if (command === 'run-batch') result = await controller.executeBatch({ account: options.account, batchId: positionals[0], limit: integer(options.limit, 10, 1000) });
  else if (command === 'worker-batch') {
    result = await controller.executeBatch({ account: options.account, batchId: options.batch, limit: integer(options.limit, 10, 1000) });
    for (const item of result.results || []) if (item.taskId) controller.recordWorkerLaunch(item.taskId,
      { pid: process.pid, log: options.log, status: item.ok ? 'finished' : 'failed', error: item.error });
  }
  else if (command === 'cancel') result = controller.cancel(requireValue(positionals[0], 'cancel TASK_ID'), { reason: options.reason });
  else if (command === 'pause') result = controller.pause({ account: options.account, batchId: options.batch, reason: options.reason });
  else if (command === 'resume') result = controller.resume({ account: options.account, batchId: options.batch });
  else if (['reconcile', 'recover'].includes(command)) result = await controller.reconcile(requireValue(positionals[0], 'reconcile TASK_ID'), { noteId: options['note-id'], absent: Boolean(options.absent), reason: options.reason });
  else if (command === 'handoff') result = controller.handoff(requireValue(positionals[0], 'handoff TASK_ID'));
  else if (command === 'link-existing') result = await controller.linkExisting(requireValue(positionals[0], 'link-existing TASK_ID'), { noteId: requireValue(options['note-id'], 'link-existing TASK_ID --note-id NOTE_ID'), reason: options.reason });
  else if (['collect', 'audit'].includes(command)) result = await controller.collect(requireValue(options.account, `${command} --account ALIAS`), integer(options.limit, 120), { audit: command === 'audit' });
  else if (command === 'metrics-history') result = controller.metricsHistory({ account: requireValue(options.account, 'metrics-history --account ALIAS'), noteId: options['note-id'], limit: integer(options.limit, 50) });
  else if (command === 'catalog') {
    const [subcommand = 'list', id] = positionals;
    if (subcommand === 'list') result = controller.catalog({ account: options.account, seriesId: options.series, contentType: options['content-type'], status: options.status, limit: integer(options.limit, 100) });
    else if (subcommand === 'sync') result = await controller.catalogSync(requireValue(options.account, 'catalog sync --account ALIAS'), { limit: integer(options.limit, 100) });
    else if (subcommand === 'set') {
      const changes = {};
      for (const [option, field] of [['series','seriesId'],['episode','episode'],['content-type','contentType'],['maintenance-status','maintenanceStatus'],['reason','reason'],['source','sourcePath']]) if (options[option] != null) changes[field] = options[option];
      if (!Object.keys(changes).length) throw new Error('catalog set requires at least one local metadata change');
      result = controller.catalogUpdate(requireValue(options.account, 'catalog set NOTE_ID --account ALIAS'), requireValue(id, 'catalog set NOTE_ID --account ALIAS'), changes);
    } else if (subcommand === 'series') {
      const alias = requireValue(options.account, 'catalog series --account ALIAS');
      result = options.title ? controller.seriesUpsert(alias, { seriesId: requireValue(options.series, 'catalog series --series ID --title TEXT'), title: options.title,
        description: options.description || '', expectedEpisodes: options.episodes ? options.episodes.split(',').map(value => value.trim()).filter(Boolean) : [] })
        : controller.series({ account: alias, seriesId: options.series });
    } else if (subcommand === 'policy') result = controller.policy(requireValue(options.account, 'catalog policy --account ALIAS'), { policy: await jsonOption(options.file, '--file') });
    else if (subcommand === 'cursor') result = controller.cursor(requireValue(options.account, 'catalog cursor --account ALIAS'), { watermark: options.watermark, boundaryNoteIds: options.boundary ? options.boundary.split(',').filter(Boolean) : [] });
    else if (subcommand === 'inspection') result = controller.inspection(requireValue(options.account, 'catalog inspection --account ALIAS'), { limit: integer(options.limit, 6, 100) });
    else throw new Error(`Unknown catalog command: ${subcommand}`);
  }
  else if (command === 'backup') result = await createBackup({ stateRoot: controller.root, destination: path.resolve(requireValue(options.out, 'backup --out DIRECTORY')) });
  else if (command === 'restore') {
    const input = { backupRoot: path.resolve(requireValue(positionals[0], 'restore BACKUP_DIRECTORY')), stateRoot: path.resolve(options.target || controller.root), pathMappings: await jsonOption(options['path-mappings'], '--path-mappings', []) };
    result = options.apply ? await restoreBackup(input) : await previewRestore(input);
  }
  else if (command === 'import-legacy') {
    const alias = requireValue(options.account, 'import-legacy SOURCE --account ALIAS');
    const account = options['user-id'] || options.profile ? { alias, userId: requireValue(options['user-id'], 'import-legacy SOURCE --account ALIAS --user-id ID --profile PROFILE'), profile: requireValue(options.profile, 'import-legacy SOURCE --account ALIAS --user-id ID --profile PROFILE') } : getAccount(alias);
    const input = { source: path.resolve(requireValue(positionals[0], 'import-legacy SOURCE --account ALIAS')), stateRoot: path.resolve(options.target || controller.root), account,
      sourceAccount: options['source-account'], pathMappings: await jsonOption(options['path-mappings'], '--path-mappings', []),
      ...(options.apply ? { apply: true, expectedSourceDigest: requireValue(options['expected-digest'], 'import-legacy SOURCE --expected-digest HASH --apply') } : {}) };
    result = options.apply ? await applyLegacyImport(input) : await previewLegacyImport(input);
  }
  else if (command === 'media-info') result = { ok: true, metadata: await inspectMediaMetadata(path.resolve(requireValue(positionals[0], 'media-info FILE')), { ffprobe: Boolean(options.ffprobe) }) };
  else if (command === 'qualify') {
    const { qualifyBackend } = await import('./lib/qualification.mjs');
    result = await qualifyBackend({ accountAlias: requireValue(options.account, 'qualify --account ALIAS'), backendLabel: options['backend-label'] || 'bundled', repeats: integer(options.repeats, 3, 20), limit: integer(options.limit, 30, 1000) });
  }
  else if (command === 'compare-qualifications') {
    if (!positionals.length) throw new Error('Usage: xhs-ops compare-qualifications FILE...');
    const { compareQualifications } = await import('./lib/qualification.mjs');
    result = await compareQualifications({ paths: positionals.map(value => path.resolve(value)) });
  }
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
