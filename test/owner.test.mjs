import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
  // A real transfer requires a readable source DB; absence is deliberately a hard stop.
  assert.throws(() => transferAccountOwner(account, { home: f.other, fromHome: f.home, reason: 'move to the new state owner' }), /unavailable/);
});
