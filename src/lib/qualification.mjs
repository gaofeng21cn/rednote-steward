import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { stateRoot } from './config.mjs';
import { buildIdentity } from './build.mjs';
import { diagnose, redactHealth } from './health.mjs';
import { readInventory, rowOf, verifiedIdentity } from './opencli.mjs';

const digest = value => createHash('sha256').update(String(value)).digest('hex');
const duration = start => Math.round((performance.now() - start) * 100) / 100;
const WRITE_CAPABILITIES = ['publishImage', 'publishVideo', 'customVideoCover', 'editExisting', 'nativeTopics', 'declarations', 'duplicateSubmission'];
function bounded(value, fallback, maximum, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  return number;
}
function errorCode(error) {
  const message = String(error?.message || '');
  if (/mismatch/i.test(message)) return 'identity_mismatch';
  if (/login|logged.in/i.test(message)) return 'login_required';
  if (/timed?.?out|timeout/i.test(message)) return 'probe_timeout';
  return 'probe_failed';
}
function summary(runs) {
  const values = runs.filter(run => run.status === 'passed').map(run => run.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { attempts: runs.length, passed: values.length, failed: runs.filter(run => run.status === 'failed').length,
    notRun: runs.filter(run => run.status === 'not_run').length,
    medianMs: values.length ? (values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) * 50) / 100) : null,
    minMs: values[0] ?? null, maxMs: values.at(-1) ?? null,
    p95Ms: values.length ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : null };
}
function qualification(runs) {
  return runs.every(run => run.status === 'passed') ? 'supported' : runs.some(run => run.status === 'failed') ? 'unavailable' : 'unknown';
}
async function bindingsAt(home) {
  const data = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid account binding schema');
  return data.accounts;
}

/** Bounded read probes. No notes, media or raw errors are retained in the private receipt. */
export async function qualifyBackend({ accountAlias, backendLabel = 'bundled', repeats = 3, limit = 30,
  root, home = stateRoot(), probes = {} } = {}) {
  if (typeof accountAlias !== 'string' || !accountAlias.trim()) throw new Error('accountAlias is required');
  if (typeof backendLabel !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(backendLabel)) throw new Error('backendLabel must use letters, numbers, dot, _ or -');
  const count = bounded(repeats, 3, 20, 'repeats'), pageLimit = bounded(limit, 30, 1000, 'limit');
  const targetHome = path.resolve(home), bindings = await bindingsAt(targetHome);
  const account = bindings.find(item => item.alias === accountAlias);
  if (!account?.userId || !account?.profile) throw new Error(`Account ${accountAlias} is not bound`);
  const identityProbe = probes.identity || verifiedIdentity;
  const inventoryProbe = probes.inventory || readInventory;
  const build = await buildIdentity(root);
  let health;
  try {
    // Keep the requested repeat count exact: a health snapshot must not perform
    // an extra account identity read that would skew the benchmark. The actual
    // identity/profile roundtrip is measured only in the loop below.
    health = redactHealth(await diagnose({ root, home: targetHome,
      accountReader: () => [], selectedAccountReader: () => account,
      ...(probes.browser ? { browserProbe: probes.browser } : {}),
    }));
  } catch (error) { health = { ok: false, errorCode: errorCode(error) }; }
  const identityRuns = [], inventoryRuns = [];
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    let identityVerified = false;
    try {
      const response = await identityProbe(account);
      const identity = rowOf(response?.json ?? response);
      if (response?.exitCode != null && response.exitCode !== 0) throw new Error('Identity probe failed');
      if (identity?.logged_in !== true || !identity.userId) throw new Error('Login required');
      if (String(identity.userId) !== String(account.userId)) throw new Error('Account identity mismatch');
      identityVerified = true;
      identityRuns.push({ attempt: index + 1, status: 'passed', durationMs: duration(started) });
    } catch (error) {
      identityRuns.push({ attempt: index + 1, status: 'failed', durationMs: duration(started), errorCode: errorCode(error) });
    }
    // An inventory read through the wrong or unknown account is not a useful benchmark.
    if (!identityVerified) {
      inventoryRuns.push({ attempt: index + 1, status: 'not_run', durationMs: null, reason: 'identity_not_verified' });
      continue;
    }
    const inventoryStarted = performance.now();
    try {
      const response = await inventoryProbe(pageLimit, account.profile);
      const rows = response?.json ?? response;
      if ((response?.exitCode != null && response.exitCode !== 0) || !Array.isArray(rows)) throw new Error('Inventory probe failed');
      inventoryRuns.push({ attempt: index + 1, status: 'passed', durationMs: duration(inventoryStarted), count: rows.length });
    } catch (error) {
      inventoryRuns.push({ attempt: index + 1, status: 'failed', durationMs: duration(inventoryStarted), errorCode: errorCode(error) });
    }
  }
  const capabilities = { readProfile: qualification(identityRuns), readInventory: qualification(inventoryRuns), readNote: 'unknown',
    ...Object.fromEntries(WRITE_CAPABILITIES.map(name => [name, 'unknown'])) };
  const report = {
    schemaVersion: 1, kind: 'rednote-backend-qualification', generatedAt: new Date().toISOString(),
    backendLabel, backendMode: process.env.XHS_OPS_OPENCLI_BIN ? 'explicit_external' : 'bundled',
    accountUserIdHash: digest(account.userId), profileHash: digest(account.profile),
    sourceRevision: build.sourceRevision, sourceDirty: build.sourceDirty, contentDigest: build.content.digest, version: build.version,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    configuredOpencliVersion: build.dependencies['@jackwener/opencli'] ?? null,
    observedCliVersion: health.browser?.cliVersion ?? null, observedDaemonVersion: health.browser?.daemonVersion ?? null,
    observedBridgeVersion: health.browser?.extensionVersion ?? null,
    limit: pageLimit, repeats: count, health,
    probes: { identity: { status: capabilities.readProfile, ...summary(identityRuns), runs: identityRuns },
      inventory: { status: capabilities.readInventory, ...summary(inventoryRuns), runs: inventoryRuns } },
    capabilities,
    evidence: { platformWrites: false, rawInventoryStored: false, titlesBodiesStored: false,
      interactionCount: 'unknown', recoveryTimeMs: 'unknown', duplicateSubmission: 'unknown' },
  };
  const directory = path.join(targetHome, 'qualification');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = path.join(directory, `${backendLabel}-${Date.now()}-${randomUUID()}.json`);
  await fs.writeFile(receipt, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { ok: capabilities.readProfile === 'supported' && capabilities.readInventory === 'supported', ...report, receipt };
}
async function readReceipt(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Qualification receipt paths must be absolute');
  const stat = await fs.stat(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error('Qualification receipt exceeds 2 MiB');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value?.kind !== 'rednote-backend-qualification' || value.schemaVersion !== 1 ||
      !value.probes?.identity || !value.probes?.inventory || !value.capabilities || !value.evidence) throw new Error('Unsupported qualification receipt');
  return value;
}

/** Compare evidence while showing configuration differences instead of declaring a universal winner. */
export async function compareQualifications({ paths: receiptPaths = [] } = {}) {
  if (!Array.isArray(receiptPaths) || receiptPaths.length < 2 || receiptPaths.length > 20) throw new Error('Provide 2 to 20 qualification receipt paths');
  const receipts = await Promise.all(receiptPaths.map(readReceipt));
  const dimensions = ['accountUserIdHash', 'sourceRevision', 'sourceDirty', 'contentDigest', 'version', 'profileHash', 'limit', 'repeats', 'runtime'];
  const comparable = Object.fromEntries(dimensions.map(name => {
    const values = receipts.map(item => item[name] ?? null);
    const known = values.every(value => value !== null);
    const equal = values.every(value => JSON.stringify(value) === JSON.stringify(values[0]));
    return [name, { status: !known ? 'unknown' : equal ? 'same' : 'different', equal, values }];
  }));
  const readSucceeded = receipts.every(item => item.probes.identity.status === 'supported' && item.probes.inventory.status === 'supported');
  return { ok: true, schemaVersion: 1, comparable, comparableForLatency: readSucceeded && dimensions.every(name => comparable[name].status === 'same'),
    results: receipts.map((receipt, index) => ({ receipt: receiptPaths[index], backendLabel: receipt.backendLabel,
      backendMode: receipt.backendMode, observedCliVersion: receipt.observedCliVersion,
      observedDaemonVersion: receipt.observedDaemonVersion, observedBridgeVersion: receipt.observedBridgeVersion,
      identity: receipt.probes.identity.status, inventory: receipt.probes.inventory.status,
      medianIdentityMs: receipt.probes.identity.medianMs, medianInventoryMs: receipt.probes.inventory.medianMs,
      capabilities: receipt.capabilities, interactionCount: receipt.evidence.interactionCount,
      recoveryTimeMs: receipt.evidence.recoveryTimeMs, duplicateSubmission: receipt.evidence.duplicateSubmission })),
    note: 'The latency comparison covers successful identity and inventory reads. Publishing, media, covers, recovery and duplicate submissions require separate evidence.' };
}
