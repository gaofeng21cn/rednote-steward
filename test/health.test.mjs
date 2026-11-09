import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildIdentity, createReleaseManifest } from '../src/lib/build.mjs';
import { diagnose, redactHealth } from '../src/lib/health.mjs';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '0.2.0', dependencies: { '@jackwener/opencli': '1.8.5' } }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/cli.mjs'), 'export const example = true;\n');
  return root;
}

test('release identity verifies public bytes and refuses to trust a stale manifest revision', async t => {
  const root = await fixture(t);
  const manifest = await createReleaseManifest(root);
  manifest.sourceRevision = 'a'.repeat(40);
  manifest.sourceDirty = false;
  await fs.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  const current = await buildIdentity(root);
  assert.equal(current.manifest.matched, true);
  assert.equal(current.sourceRevision, 'a'.repeat(40));
  await fs.writeFile(path.join(root, 'src/cli.mjs'), 'Changed source bytes\n');
  const drifted = await buildIdentity(root);
  assert.equal(drifted.manifest.matched, false);
  assert.equal(drifted.sourceRevision, null);
  assert.notEqual(drifted.content.digest, current.content.digest);
});

test('doctor reports exact account roundtrip while leaving untested publishing capabilities unknown', async t => {
  const root = await fixture(t);
  const home = path.join(root, 'private');
  const binding = { alias: 'example', userId: 'synthetic-user', profile: 'synthetic-profile' };
  const report = await diagnose({ root, home, accountAlias: binding.alias,
    accountReader: () => [binding], selectedAccountReader: () => binding,
    ownerProbe: () => ({ state: 'unregistered', leases: [] }),
    identityProbe: async () => ({ userId: binding.userId, logged_in: true }),
    browserProbe: async profile => {
      assert.equal(profile, binding.profile);
      return { exitCode: 0, json: { daemonRunning: true, daemonVersion: '1.8.5', extensionConnected: true, extensionVersion: '1.0.26', connectivity: { ok: true } } };
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.accounts[0].identity.state, 'verified');
  assert.equal(report.capabilities.accountIdentity.liveQualification, 'supported');
  assert.equal(report.capabilities.videoPublish.liveQualification, 'unknown');
  assert.equal(report.installation.state.exists, false);
  await assert.rejects(fs.stat(home), { code: 'ENOENT' });
});

test('doctor distinguishes identity mismatch and state owner conflict', async t => {
  const root = await fixture(t);
  const binding = { alias: 'example', userId: 'synthetic-user', profile: 'synthetic-profile' };
  const report = await diagnose({ root, home: root, accountAlias: binding.alias,
    accountReader: () => [binding], selectedAccountReader: () => binding,
    ownerProbe: () => ({ state: 'conflict', leases: [], conflicts: [{ home: 'other-state' }] }),
    identityProbe: async () => { throw new Error('Account identity mismatch'); },
    browserProbe: async () => ({ exitCode: 0, json: { extensionConnected: true } }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.accounts[0].identity.state, 'mismatch');
  assert.equal(report.accounts[0].owner.state, 'conflict');
});

test('a zero exit code cannot hide a known disconnected bridge while absent connection fields stay unknown', async t => {
  const root = await fixture(t);
  const options = { root, home: path.join(root, 'state'), accountReader: () => [],
    ownerProbe: () => ({ state: 'unregistered', leases: [] }) };
  const disconnected = await diagnose({ ...options, browserProbe: async () => ({ exitCode: 0, json: { daemonRunning: true, extensionConnected: false } }) });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.browser.state, 'disconnected');
  assert.equal(disconnected.checks.find(item => item.name === 'opencli').status, 'failed');
  const stopped = await diagnose({ ...options, browserProbe: async () => ({ exitCode: 0, json: { daemonRunning: false } }) });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.browser.state, 'not_running');
  const unknown = await diagnose({ ...options, browserProbe: async () => ({ exitCode: 0, json: { ok: true } }) });
  assert.equal(unknown.browser.state, 'unknown');
  assert.equal(unknown.checks.find(item => item.name === 'opencli').status, 'unknown');
});

test('owned tab cleanup reports minimum Bridge compatibility without claiming live qualification', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'adapters/opencli/xiaohongshu'), { recursive: true });
  await fs.writeFile(path.join(root, 'adapters/opencli/xiaohongshu/owned-tab.mjs'), 'export {};\n');
  const options = { root, home: path.join(root, 'state'), accountReader: () => [],
    ownerProbe: () => ({ state: 'unregistered', leases: [] }) };
  const inspect = extensionVersion => diagnose({ ...options, browserProbe: async () => ({ exitCode: 0,
    json: { extensionConnected: true, daemonRunning: true, extensionVersion } }) });
  for (const version of ['1.0.26', '1.0.27', '1.1.0']) {
    const report = await inspect(version);
    assert.equal(report.ok, true);
    assert.deepEqual(report.capabilities.ownedTabCleanup, { implementation: 'present', liveQualification: 'unknown',
      bridgeCompatibility: { state: 'compatible', minimumVersion: '1.0.26', observedVersion: version } });
  }
  const old = await inspect('1.0.25');
  assert.equal(old.ok, false);
  assert.equal(old.capabilities.ownedTabCleanup.bridgeCompatibility.state, 'unavailable');
  assert.equal(old.capabilities.ownedTabCleanup.liveQualification, 'unknown');
  assert.equal(old.checks.find(item => item.name === 'ownedTabCleanup').status, 'failed');
  assert.match(old.capabilities.ownedTabCleanup.repair, /setup --browser-extension/);
  assert.equal(old.next.some(item => /chrome:\/\/extensions/.test(item) && /load or reload/.test(item)), true);
  for (const version of [undefined, 'unknown', '1.0.invalid']) {
    const report = await inspect(version);
    assert.equal(report.capabilities.ownedTabCleanup.bridgeCompatibility.state, 'unknown');
    assert.equal(report.capabilities.ownedTabCleanup.liveQualification, 'unknown');
    assert.equal(report.checks.find(item => item.name === 'ownedTabCleanup').status, 'unknown');
  }
  const redacted = redactHealth(old);
  assert.deepEqual(redacted.capabilities.ownedTabCleanup.bridgeCompatibility, { state: 'unavailable', minimumVersion: '1.0.26', observedVersion: '1.0.25' });
  assert.equal(redacted.capabilities.ownedTabCleanup.liveQualification, 'unknown');
  assert.equal(JSON.stringify(redacted).includes(root), false);
});

test('doctor displays a dated read-only qualification and marks changed build evidence stale', async t => {
  const root = await fixture(t), home = path.join(root, 'private');
  const binding = { alias: 'example', userId: 'synthetic-user', profile: 'synthetic-profile' };
  const hash = value => createHash('sha256').update(value).digest('hex');
  const build = await buildIdentity(root);
  const receipt = { schemaVersion: 1, kind: 'rednote-backend-qualification', generatedAt: '2026-11-08T09:00:00.000Z',
    accountUserIdHash: hash(binding.userId), profileHash: hash(binding.profile), contentDigest: build.content.digest,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    observedCliVersion: '1.8.5', observedDaemonVersion: '1.8.5', observedBridgeVersion: '1.0.26',
    capabilities: { readProfile: 'supported', readInventory: 'supported', readNote: 'unknown', publishVideo: 'supported' } };
  await fs.mkdir(path.join(home, 'qualification'), { recursive: true });
  await fs.writeFile(path.join(home, 'qualification', 'example.json'), JSON.stringify(receipt));
  const options = { root, home, accountAlias: binding.alias, accountReader: () => [binding], selectedAccountReader: () => binding,
    ownerProbe: () => ({ state: 'owned', leases: [] }), identityProbe: async () => ({ userId: binding.userId, logged_in: true }),
    browserProbe: async () => ({ exitCode: 0, json: { extensionConnected: true, cliVersion: '1.8.5', daemonVersion: '1.8.5', extensionVersion: '1.0.26' } }) };
  const current = await diagnose(options);
  assert.equal(current.qualification.state, 'current');
  assert.equal(current.qualification.capturedAt, receipt.generatedAt);
  assert.equal(current.capabilities.readInventory.liveQualification, 'supported');
  assert.equal(current.capabilities.videoPublish.liveQualification, 'unknown');
  const publicReport = JSON.stringify(redactHealth(current));
  for (const privateValue of [home, receipt.accountUserIdHash, receipt.profileHash]) assert.equal(publicReport.includes(privateValue), false);
  await fs.writeFile(path.join(root, 'src/cli.mjs'), 'Changed build\n');
  const stale = await diagnose(options);
  assert.equal(stale.qualification.state, 'stale');
  assert.equal(stale.qualification.reasons.includes('content_digest_changed'), true);
  assert.equal(stale.capabilities.readInventory.liveQualification, 'unknown');
});

test('public diagnostics omit account identities, profiles, private paths and raw errors', async t => {
  const root = await fixture(t);
  const binding = { alias: 'secret-account', userId: 'secret-user', profile: 'secret-profile' };
  const report = await diagnose({ root, home: path.join(root, 'private-secret'), accountAlias: binding.alias,
    accountReader: () => [binding], selectedAccountReader: () => binding,
    ownerProbe: () => ({ state: 'owned', home: 'private-owner', owners: [{ home: 'private-source' }], leases: [] }),
    identityProbe: async () => { throw new Error('private error contains a file'); },
    browserProbe: async () => ({ exitCode: 1, json: { issues: ['private browser error'], profiles: [{ contextId: 'private-context' }] } }),
  });
  const visible = JSON.stringify(redactHealth(report));
  for (const secret of [root, binding.alias, binding.userId, binding.profile, 'private-owner', 'private-source', 'private-context', 'private error', 'private browser error']) assert.equal(visible.includes(secret), false, secret);
  assert.equal(JSON.parse(visible).redacted, true);
});

test('CLI doctor and account status share the same isolated owner and preserve the public redaction boundary', async t => {
  const root = await fixture(t);
  const env = { ...process.env, XHS_OPS_HOME: path.join(root, 'state'), XHS_OPS_OWNER_HOME: path.join(root, 'owners'),
    XHS_OPS_OPENCLI_BIN: path.join(project, 'test/fixtures/fake-opencli.mjs'), FAKE_OPENCLI_STATE: path.join(root, 'platform.json') };
  const cli = path.join(project, 'src/cli.mjs');
  await exec(process.execPath, [cli, 'account', 'add', 'doctor-example', '--user-id', 'demo-user-001', '--profile', 'doctor-profile'], { env });
  const status = JSON.parse((await exec(process.execPath, [cli, 'account', 'status', 'doctor-example'], { env })).stdout);
  assert.equal(status.accounts[0].owner.state, 'owned');
  const full = JSON.parse((await exec(process.execPath, [cli, 'doctor', '--account', 'doctor-example'], { env })).stdout);
  assert.equal(full.accounts[0].identity.state, 'verified');
  assert.equal(full.capabilities.videoPublish.liveQualification, 'unknown');
  const redacted = (await exec(process.execPath, [cli, 'doctor', '--account', 'doctor-example', '--redact'], { env })).stdout;
  assert.equal(JSON.parse(redacted).redacted, true);
  for (const value of [root, 'demo-user-001', 'doctor-profile', 'doctor-example']) assert.equal(redacted.includes(value), false);
});
