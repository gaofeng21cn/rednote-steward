import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIdentity, readJson, PACKAGE_ROOT } from './build.mjs';
import { getAccount, listAccounts, stateRoot } from './config.mjs';
import { runOpencli, verifiedIdentity } from './opencli.mjs';
import { inspectAccountOwner } from './owner.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

const CAPABILITY_FILES = {
  imagePublish: 'adapters/opencli/xiaohongshu/steward-publish.js',
  videoPublish: 'adapters/opencli/xiaohongshu/steward-publish.js',
  customVideoCover: 'adapters/opencli/xiaohongshu/cover-editor.mjs',
  nativeTopics: 'adapters/opencli/xiaohongshu/editor-helpers.mjs',
  declarations: 'adapters/opencli/xiaohongshu/declarations.mjs',
  editTextAndTopics: 'adapters/opencli/xiaohongshu/edit-note.js',
  replaceVideo: 'adapters/opencli/xiaohongshu/edit-note.js',
  sameNoteReadback: 'adapters/opencli/xiaohongshu/steward-read-note.js',
  ownedTabCleanup: 'adapters/opencli/xiaohongshu/owned-tab.mjs',
};

const OWNED_TAB_MINIMUM_BRIDGE = '1.0.26';
const OWNED_TAB_BRIDGE_REPAIR = 'Run xhs-ops setup --browser-extension to prepare the current Browser Bridge, then load or reload that version in chrome://extensions and repeat doctor.';
function ownedTabBridgeCompatibility(version) {
  const observed = typeof version === 'string' ? version.trim() : '';
  const parts = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(observed);
  if (!parts) return { state: 'unknown', minimumVersion: OWNED_TAB_MINIMUM_BRIDGE, observedVersion: null };
  const values = parts.slice(1).map(value => Number(value || 0));
  const minimum = [1, 0, 26, 0];
  let comparison = 0;
  for (let index = 0; index < minimum.length; index++) {
    if (values[index] !== minimum[index]) { comparison = values[index] - minimum[index]; break; }
  }
  return { state: comparison >= 0 ? 'compatible' : 'unavailable', minimumVersion: OWNED_TAB_MINIMUM_BRIDGE,
    observedVersion: observed };
}

const identityHash = value => createHash('sha256').update(String(value)).digest('hex');
async function latestQualification({ home, account, build, browser }) {
  if (!account) return { state: 'not_requested', capturedAt: null, capabilities: {} };
  const directory = path.join(home, 'qualification');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'absent', capturedAt: null, capabilities: {} }; throw error; }
  const receipts = [];
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json')).slice(-1000)) {
    const receiptPath = path.join(directory, entry.name);
    try {
      if ((await fs.stat(receiptPath)).size > 2 * 1024 * 1024) continue;
      const receipt = await readJson(receiptPath);
      if (receipt?.kind !== 'rednote-backend-qualification' || receipt.schemaVersion !== 1 ||
        receipt.accountUserIdHash !== identityHash(account.userId) || receipt.profileHash !== identityHash(account.profile) ||
        !Number.isFinite(Date.parse(receipt.generatedAt))) continue;
      receipts.push({ receipt, receiptPath });
    } catch { /* A partial or unsupported receipt is not qualification evidence. */ }
  }
  const latest = receipts.sort((a, b) => Date.parse(b.receipt.generatedAt) - Date.parse(a.receipt.generatedAt))[0];
  if (!latest) return { state: 'absent', capturedAt: null, capabilities: {} };
  const { receipt, receiptPath } = latest;
  const reasons = [];
  if (receipt.contentDigest !== build.content.digest) reasons.push('content_digest_changed');
  const runtime = { node: process.version, platform: process.platform, arch: process.arch };
  for (const [key, value] of Object.entries(runtime)) if (receipt.runtime?.[key] !== value) reasons.push(`runtime_${key}_changed`);
  for (const [receiptKey, browserKey] of [['observedCliVersion', 'cliVersion'], ['observedDaemonVersion', 'daemonVersion'], ['observedBridgeVersion', 'extensionVersion']]) {
    if (!receipt[receiptKey] || !browser[browserKey]) reasons.push(`${browserKey}_unknown`);
    else if (receipt[receiptKey] !== browser[browserKey]) reasons.push(`${browserKey}_changed`);
  }
  const capabilities = Object.fromEntries(['readProfile', 'readInventory', 'readNote'].map(name => [name,
    ['supported', 'unavailable', 'unknown'].includes(receipt.capabilities?.[name]) ? receipt.capabilities[name] : 'unknown']));
  return { state: reasons.length ? 'stale' : 'current', capturedAt: receipt.generatedAt, reasons, capabilities, receipt: receiptPath };
}

function browserStatus(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return { state: 'unknown', cliVersion: null, daemonVersion: null,
    extensionVersion: null, profiles: [], connectivity: 'unknown', issues: [] };
  const state = row.extensionConnected === true ? 'connected'
    : row.daemonRunning === false ? 'not_running'
    : row.extensionConnected === false ? 'disconnected' : 'unknown';
  return {
    state,
    cliVersion: row.cliVersion ?? null,
    daemonVersion: row.daemonVersion ?? null,
    extensionVersion: row.extensionVersion ?? null,
    profiles: Array.isArray(row.profiles) ? row.profiles.map(profile => ({
      contextId: profile.contextId ?? null,
      connected: profile.connected ?? null,
      extensionVersion: profile.extensionVersion ?? null,
    })) : [],
    connectivity: row.connectivity?.ok === true ? 'passed' : row.connectivity?.ok === false ? 'failed' : 'unknown',
    issues: Array.isArray(row.issues) ? row.issues : [],
  };
}

async function probeBrowser(profile) {
  if (process.env.XHS_OPS_OPENCLI_BIN) return runOpencli(['doctor'], { timeoutMs: 60_000, profile });
  const registry = fileURLToPath(import.meta.resolve('@jackwener/opencli/registry'));
  const runtime = path.dirname(registry);
  const pkg = await readJson(path.resolve(runtime, '../../package.json'), {});
  const url = pathToFileURL(path.join(runtime, 'doctor.js')).href;
  const script = `const {runBrowserDoctor}=await import(${JSON.stringify(url)}); console.log(JSON.stringify(await runBrowserDoctor({cliVersion:${JSON.stringify(pkg.version)}})));`;
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...(profile ? { OPENCLI_PROFILE: profile } : {}) }, timeout: 25_000, maxBuffer: 1024 * 1024,
    });
    const json = JSON.parse(stdout.trim());
    return { exitCode: json.connectivity?.ok && json.extensionConnected ? 0 : 1, json, stdout, stderr };
  } catch (error) { return { exitCode: 1, json: null, stdout: error.stdout || '', stderr: error.stderr || error.message }; }
}

async function accountReport(account, { selected, home, identityProbe, ownerProbe }) {
  const owner = await ownerProbe({ userId: account.userId, profile: account.profile }, { home });
  let identity = { state: selected ? 'not_checked' : 'not_requested' };
  if (selected) {
    try {
      const value = await identityProbe(account);
      identity = { state: value?.logged_in !== true ? 'login_required' : value?.userId === account.userId ? 'verified' : 'mismatch',
        userId: value?.userId ?? null, loggedIn: value?.logged_in === true };
    } catch (error) {
      identity = { state: /identity mismatch/i.test(error.message) ? 'mismatch' : /login/i.test(error.message) ? 'login_required' : 'failed', error: error.message };
    }
  }
  return { alias: account.alias, userId: account.userId, profile: account.profile, owner, identity };
}

export async function diagnose({ accountAlias, root = PACKAGE_ROOT, home = stateRoot(),
  browserProbe = probeBrowser,
  identityProbe = verifiedIdentity, accountReader = listAccounts, selectedAccountReader = getAccount,
  ownerProbe = inspectAccountOwner } = {}) {
  const build = await buildIdentity(root);
  const installRoot = path.resolve(process.env.XHS_OPS_INSTALL_ROOT || path.join(os.homedir(), '.local/share/rednote-steward/app'));
  const installReceipt = await readJson(path.join(installRoot, 'install.json'));
  const stateReceipt = await readJson(path.join(home, 'installation.json'));
  const chosen = accountAlias ? selectedAccountReader(accountAlias) : null;
  const browserResult = await browserProbe(chosen?.profile);
  const browser = browserStatus(browserResult.json);
  const ownedTabCompatibility = ownedTabBridgeCompatibility(browser.extensionVersion);
  const qualification = await latestQualification({ home, account: chosen, build, browser });
  const bound = accountReader();
  const accounts = await Promise.all(bound.map(item => accountReport(item, {
    selected: item.alias === accountAlias, home, identityProbe, ownerProbe,
  })));
  const browserCheck = browserResult.exitCode !== 0 || ['disconnected', 'not_running'].includes(browser.state) || browser.connectivity === 'failed'
    ? 'failed' : browser.state === 'unknown' ? 'unknown' : 'passed';
  const checks = [
    { name: 'node', status: Number(process.versions.node.split('.')[0]) >= 24 ? 'passed' : 'failed', detail: process.version },
    { name: 'source', status: build.sourceRevision ? 'known' : 'unknown', revision: build.sourceRevision, dirty: build.sourceDirty },
    { name: 'contentDigest', status: build.content.digest ? 'computed' : 'unknown', ...build.content },
    { name: 'releaseManifest', status: build.manifest.matched ? 'matched' : build.manifest.present ? 'mismatch' : 'absent', ...build.manifest },
    { name: 'opencli', status: browserCheck, packageVersion: build.dependencies['@jackwener/opencli'] ?? null, browser },
    { name: 'ownedTabCleanup', status: ownedTabCompatibility.state === 'unavailable' ? 'failed' : ownedTabCompatibility.state,
      bridgeCompatibility: ownedTabCompatibility },
    { name: 'installationReceipt', status: installReceipt ? (installReceipt.version === build.version ? 'matched' : 'different') : 'unknown',
      version: installReceipt?.version ?? null, sourceRevision: installReceipt?.sourceRevision ?? null,
      contentDigest: installReceipt?.contentDigest ?? null, stateReceiptVersion: stateReceipt?.version ?? null },
    { name: 'account', status: accountAlias ? (accounts.find(item => item.alias === accountAlias)?.identity.state ?? 'unknown') : 'not_requested', alias: accountAlias ?? null },
  ];
  const capabilities = Object.fromEntries(await Promise.all(Object.entries(CAPABILITY_FILES).map(async ([name, relative]) => {
    let implementation = 'absent';
    try { if ((await fs.stat(path.join(root, relative))).isFile()) implementation = 'present'; }
    catch { implementation = 'absent'; }
    return [name, { implementation, liveQualification: 'unknown' }];
  })));
  capabilities.ownedTabCleanup.bridgeCompatibility = ownedTabCompatibility;
  if (ownedTabCompatibility.state === 'unavailable') capabilities.ownedTabCleanup.repair = OWNED_TAB_BRIDGE_REPAIR;
  capabilities.accountIdentity = { implementation: 'present', liveQualification: accountAlias
    ? accounts.find(item => item.alias === accountAlias)?.identity.state === 'verified' ? 'supported' : 'unavailable' : 'unknown' };
  capabilities.readInventory = { implementation: 'present',
    liveQualification: qualification.state === 'current' ? qualification.capabilities.readInventory : 'unknown',
    lastQualifiedAt: qualification.capturedAt };
  let state = { exists: false, schemaVersion: null, unresolved: [] };
  try {
    await fs.access(path.join(home, 'xhs-ops.sqlite'));
    const database = new DatabaseSync(path.join(home, 'xhs-ops.sqlite'), { readOnly: true });
    try {
      const schema = database.prepare('PRAGMA user_version').get();
      state = { exists: true, schemaVersion: schema.user_version,
        unresolved: database.prepare("SELECT id,account,state FROM tasks WHERE state IN ('running','submitted','needs_review')").all() };
    } finally { database.close(); }
  } catch (error) { if (error.code !== 'ENOENT') state = { ...state, error: error.message }; }
  const selected = accounts.find(item => item.alias === accountAlias);
  const healthy = checks.every(check => !['failed', 'mismatch'].includes(check.status)) &&
    !state.error && accounts.every(item => item.owner.state !== 'conflict') && (!accountAlias || selected?.identity.state === 'verified');
  return {
    schemaVersion: 1, ok: healthy, generatedAt: new Date().toISOString(),
    runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
    build, installation: { installRoot, installedVersion: installReceipt?.version ?? null,
      installedSourceRevision: installReceipt?.sourceRevision ?? null, installedContentDigest: installReceipt?.contentDigest ?? null,
      currentVersion: build.version, stateRoot: home, state },
    browser, selectedAccount: chosen?.alias ?? null, accounts, capabilities, qualification, checks,
    next: [
      ...(browserCheck === 'failed' ? ['Open the bound Chrome profile and enable Browser Bridge, then repeat doctor.'] : []),
      ...(ownedTabCompatibility.state === 'unavailable' ? [OWNED_TAB_BRIDGE_REPAIR] : []),
      ...(accountAlias && selected?.identity.state !== 'verified' ? ['Sign in to the intended account and repeat account probe; retain its stable ID binding.'] : []),
      ...(accounts.some(item => item.owner.state === 'conflict') ? ['Inspect account status and its exact previous home before a controlled ownership transfer.'] : []),
      'Publishing, custom covers and edits remain unknown until an explicitly authorized platform operation is read back.',
    ],
  };
}

/** Public diagnostics contain status and versions, never private paths, identities, media or raw errors. */
export function redactHealth(report) {
  return { schemaVersion: report.schemaVersion, ok: report.ok, generatedAt: report.generatedAt, redacted: true,
    runtime: { node: report.runtime.node, platform: report.runtime.platform, arch: report.runtime.arch },
    build: { product: report.build.product, version: report.build.version, sourceRevision: report.build.sourceRevision,
      sourceDirty: report.build.sourceDirty, content: report.build.content, manifest: report.build.manifest,
      dependencies: report.build.dependencies, browserBridgeVersion: report.build.browserBridge.version },
    installation: { installedVersion: report.installation.installedVersion, installedSourceRevision: report.installation.installedSourceRevision,
      installedContentDigest: report.installation.installedContentDigest, stateExists: report.installation.state.exists,
      schemaVersion: report.installation.state.schemaVersion, unresolvedCount: report.installation.state.unresolved.length },
    browser: { state: report.browser.state, cliVersion: report.browser.cliVersion, daemonVersion: report.browser.daemonVersion,
      extensionVersion: report.browser.extensionVersion, connectivity: report.browser.connectivity,
      connectedProfileCount: report.browser.profiles.length },
    accounts: report.accounts.map(item => ({ ownerState: item.owner.state, identityState: item.identity.state,
      unresolvedLeaseCount: item.owner.leases?.length || 0 })),
    capabilities: report.capabilities,
    qualification: { state: report.qualification.state, capturedAt: report.qualification.capturedAt,
      reasons: report.qualification.reasons || [], capabilities: report.qualification.capabilities },
    checks: report.checks.map(item => ({ name: item.name, status: item.status })), next: report.next,
  };
}
