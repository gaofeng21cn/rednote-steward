import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { qualifyBackend, compareQualifications } from '../src/lib/qualification.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-qualification-'));
  const home = path.join(base, 'state'), root = path.join(base, 'source');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(home, 'accounts.json'), JSON.stringify({ schemaVersion: 1, accounts: [{ alias: 'demo', userId: 'demo-user', profile: 'chrome-main' }] }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '0.2.0', dependencies: { '@jackwener/opencli': '1.8.5' } }));
  await fs.writeFile(path.join(root, 'src', 'entry.mjs'), 'export {};\n');
  const probes = { identity: async account => ({ logged_in: true, userId: account.userId, username: 'private-name' }),
    inventory: async () => ({ exitCode: 0, json: [{ id: 'synthetic', title: 'private-title', body: 'private-body' }] }),
    browser: async () => ({ exitCode: 0, json: { extensionConnected: true, cliVersion: '1.8.5', daemonVersion: '1.8.5', extensionVersion: '1.0.26' } }) };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { root, home, probes };
}

test('read-only qualification stores no content and never upgrades writes from read success', async t => {
  const f = await fixture(t);
  let identityCalls = 0;
  f.probes.identity = async account => { identityCalls++; return { logged_in: true, userId: account.userId }; };
  const result = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 2, limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(identityCalls, 2);
  assert.equal(result.capabilities.publishVideo, 'unknown');
  assert.equal(result.capabilities.customVideoCover, 'unknown');
  assert.equal(result.probes.inventory.passed, 2);
  assert.equal(result.probes.inventory.runs[0].count, 1);
  const receipt = await fs.readFile(result.receipt, 'utf8');
  for (const secret of ['private-name', 'private-title', 'private-body', 'demo-user', 'chrome-main', f.home]) assert.equal(receipt.includes(secret), false, secret);
  assert.equal((await fs.stat(result.receipt)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(f.home, 'xhs-ops.sqlite')), { code: 'ENOENT' });
});

test('identity mismatch skips inventory, records a safe error code and is not latency-comparable', async t => {
  const f = await fixture(t); let inventoryCalls = 0;
  f.probes.identity = async () => ({ logged_in: true, userId: 'wrong-account', body: 'private identity payload' });
  f.probes.inventory = async () => { inventoryCalls++; return []; };
  const first = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 1, backendLabel: 'bundled' });
  const second = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 1, backendLabel: 'candidate' });
  assert.equal(first.ok, false); assert.equal(inventoryCalls, 0);
  assert.equal(first.probes.identity.runs[0].errorCode, 'identity_mismatch');
  assert.equal(first.probes.inventory.status, 'unknown');
  assert.equal((await compareQualifications({ paths: [first.receipt, second.receipt] })).comparableForLatency, false);
});

test('comparison exposes unequal setup dimensions and keeps unmeasured operational metrics unknown', async t => {
  const f = await fixture(t);
  const first = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 1, limit: 5 });
  const second = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 2, limit: 10, backendLabel: 'candidate' });
  const result = await compareQualifications({ paths: [first.receipt, second.receipt] });
  assert.equal(result.ok, true); assert.equal(result.comparable.limit.equal, false);
  assert.equal(result.comparable.repeats.equal, false); assert.equal(result.comparableForLatency, false);
  assert.equal(result.results[0].interactionCount, 'unknown');
  assert.equal(result.results[0].duplicateSubmission, 'unknown');
});

test('failed inventory never stores raw errors and limits reject before creating a receipt', async t => {
  const f = await fixture(t);
  f.probes.inventory = async () => { throw new Error('secret-file secret-cookie'); };
  const result = await qualifyBackend({ accountAlias: 'demo', ...f, repeats: 1 });
  assert.equal(result.ok, false); assert.equal(result.probes.inventory.status, 'unavailable');
  assert.equal((await fs.readFile(result.receipt, 'utf8')).includes('secret-cookie'), false);
  await assert.rejects(() => qualifyBackend({ accountAlias: 'demo', ...f, repeats: 21 }), /repeats/);
  await assert.rejects(() => compareQualifications({ paths: ['relative.json', '/tmp/missing.json'] }), /absolute/);
});
