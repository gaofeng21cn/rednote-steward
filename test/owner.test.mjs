import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { acquireAccountWrite, inspectAccountOwner, registerAccountOwner, resolveAccountWrite, transferAccountOwner } from '../src/lib/owner.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-owner-'));
  const previous = process.env.XHS_OPS_OWNER_HOME;
  t.after(async () => { if (previous == null) delete process.env.XHS_OPS_OWNER_HOME; else process.env.XHS_OPS_OWNER_HOME = previous; await fs.rm(root, { recursive: true, force: true }); });
  process.env.XHS_OPS_OWNER_HOME = path.join(root, 'registry');
  return { root, home: path.join(root, 'state'), other: path.join(root, 'other') };
}

test('same machine owner blocks a second home on either UID or profile', async t => {
  const f = await fixture(t);
  const account = { alias: 'demo', userId: 'demo-user-001', profile: 'chrome-main' };
  registerAccountOwner(account, { home: f.home });
  assert.throws(() => registerAccountOwner({ ...account, alias: 'copy' }, { home: f.other }), /another state owner/);
  assert.throws(() => registerAccountOwner({ ...account, profile: 'another-profile' }, { home: f.other }), /another state owner/);
  assert.throws(() => registerAccountOwner({ ...account, userId: 'another-user' }, { home: f.other }), /another state owner/);
  registerAccountOwner({ alias: 'separate', userId: 'separate-user', profile: 'separate-profile' }, { home: f.other });
  assert.equal(inspectAccountOwner(account, { home: f.other }).state, 'conflict');
});

test('unresolved lease remains after process release and resolves explicitly', async t => {
  const f = await fixture(t);
  const account = { alias: 'demo', userId: 'demo-user-001', profile: 'chrome-main' };
  registerAccountOwner(account, { home: f.home });
  const lease = acquireAccountWrite({ ...account, home: f.home, taskId: 'xhs_demo_1', attemptId: '1' });
  assert.throws(() => resolveAccountWrite({ ...account, home: f.home, taskId: 'xhs_demo_1', reason: 'not yet finished' }), /still active/);
  assert.equal(lease.release({ unresolved: true }).unresolved, true);
  assert.throws(() => acquireAccountWrite({ ...account, home: f.home, taskId: 'xhs_demo_2' }), /reconcile/);
  assert.equal(resolveAccountWrite({ ...account, home: f.home, taskId: 'xhs_demo_1', reason: 'platform readback completed' }).released, true);
  // A separate confirmed task can release its own write lease.
  const second = acquireAccountWrite({ ...account, home: f.home, taskId: 'xhs_demo_3' });
  assert.deepEqual(second.release(), { released: true, unresolved: false });
});

test('ownership transfer refuses a previous state with unresolved tasks', async t => {
  const f = await fixture(t);
  const account = { alias: 'demo', userId: 'demo-user-001', profile: 'chrome-main' };
  registerAccountOwner(account, { home: f.home });
  await fs.mkdir(f.home, { recursive: true });
  // A transfer needs a readable source DB and a resolved platform outcome.
  assert.throws(() => transferAccountOwner(account, { home: f.other, fromHome: f.home, reason: 'move to the new state owner' }), /unavailable/);
  const db = new DatabaseSync(path.join(f.home, 'xhs-ops.sqlite'));
  db.exec(`CREATE TABLE tasks (id TEXT,state TEXT,account TEXT,account_user_id TEXT,browser_profile TEXT);
    INSERT INTO tasks VALUES ('xhs_old','needs_review','demo','demo-user-001','chrome-main')`);
  assert.throws(() => transferAccountOwner(account, { home: f.other, fromHome: f.home, reason: 'move to the new state owner' }), /unresolved tasks/);
  db.exec("UPDATE tasks SET state='verified'"); db.close();
  const transferred = transferAccountOwner(account, { home: f.other, fromHome: f.home, reason: 'history copied and checked' });
  assert.equal(transferred.previousHome, await fs.realpath(f.home));
  assert.equal(inspectAccountOwner(account, { home: f.other }).state, 'owned');
  assert.equal(inspectAccountOwner(account, { home: f.home }).state, 'conflict');
});

test('a dead writer still requires platform reconciliation before another lease', async t => {
  const f = await fixture(t);
  const account = { alias: 'demo', userId: 'demo-user-001', profile: 'chrome-main' };
  const ownerModule = new URL('../src/lib/owner.mjs', import.meta.url).href;
  const input = { ...account, home: f.home, taskId: 'xhs_crashed' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {acquireAccountWrite} from ${JSON.stringify(ownerModule)}; acquireAccountWrite(${JSON.stringify(input)});`], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const observed = inspectAccountOwner(account, { home: f.home }).leases[0];
  assert.equal(observed.process_active, false);
  assert.equal(observed.observed_state, 'stale_unknown');
  assert.throws(() => acquireAccountWrite({ ...account, home: f.home, taskId: 'xhs_next' }), /reconcile/);
  const resolved = resolveAccountWrite({ ...input, reason: 'same note found and verified' });
  assert.equal(resolved.leases, 1);
  const next = acquireAccountWrite({ ...account, home: f.home, taskId: 'xhs_next' });
  assert.equal(next.release().released, true);
});

test('inspection on an untouched owner root creates no registry', async t => {
  const f = await fixture(t);
  const result = inspectAccountOwner({ userId: 'demo-user-001', profile: 'chrome-main' }, { home: f.home });
  assert.equal(result.state, 'unregistered');
  await assert.rejects(fs.stat(process.env.XHS_OPS_OWNER_HOME), { code: 'ENOENT' });
});
