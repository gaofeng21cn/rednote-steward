import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOwnedTab, withOwnedTabCleanup, configureOwnedTabRetention } from '../adapters/opencli/xiaohongshu/owned-tab.mjs';

const page = (overrides = {}) => ({
  session: 'site:xiaohongshu:profile-1',
  surface: 'adapter',
  contextId: 'context-7',
  windowMode: 'background',
  ...overrides,
});

test('closeOwnedTab sends only the exact adapter session context', async () => {
  const calls = [];
  const result = await closeOwnedTab(page(), {
    sendCommand: async (...args) => { calls.push(args); return { closed: true }; },
  });
  assert.deepEqual(result, { closed: true, preparedForClose: false });
  assert.deepEqual(calls, [[ 'close-owned-tab', {
    session: 'site:xiaohongshu:profile-1',
    surface: 'adapter',
    contextId: 'context-7',
    windowMode: 'background',
  } ]]);
});

test('closeOwnedTab replaces a dirty document before requesting exact tab removal', async () => {
  const steps = [];
  const result = await closeOwnedTab(page({
    evaluate: async source => { steps.push(['evaluate', source]); return true; },
    _page: 'target-7',
  }), {
    sendCommand: async (action, params) => {
      steps.push(['send', action, params]);
      return action === 'tabs' && params.op === 'list' ? [{ page: 'target-7' }] : { closed: true };
    },
  });
  assert.deepEqual(result, { closed: true, preparedForClose: true });
  assert.equal(steps.length, 4);
  assert.equal(steps[1][2].op, 'select');
  assert.equal(steps[2][0], 'evaluate');
  assert.match(steps[2][1], /window\.onbeforeunload = null/);
  assert.match(steps[2][1], /document\.open\(\)/);
  assert.equal(steps[3][1], 'close-owned-tab');
});

test('document preparation failure still attempts exact tab cleanup', async () => {
  let sends = 0;
  const result = await closeOwnedTab(page({
    evaluate: async () => { throw new Error('document already navigated'); },
    _page: 'target-7',
  }), {
    sendCommand: async (action, params) => {
      if (action === 'tabs') return params.op === 'list' ? [{ page: 'target-7' }] : {};
      sends++; return { closed: true };
    },
  });
  assert.deepEqual(result, { closed: true, preparedForClose: false });
  assert.equal(sends, 1);
});

test('cleanup never evaluates an unvisited, borrowed, stale or persistent page', async () => {
  for (const mode of ['unvisited', 'borrowed', 'stale', 'persistent']) {
    let evaluations = 0;
    const actions = [];
    const result = await closeOwnedTab(page({
      ...(mode === 'unvisited' ? {} : { _page: 'target-7' }),
      ...(mode === 'persistent' ? { siteSession: 'persistent' } : {}),
      evaluate: async () => { evaluations++; },
    }), { sendCommand: async (action, params) => {
      actions.push(action);
      if (action === 'tabs' && params.op === 'list') return [{ page: mode === 'stale' ? 'other-target' : 'target-7' }];
      if (action === 'tabs') throw new Error('bound_tab_mutation_blocked');
      return { closed: true };
    } });
    assert.equal(evaluations, 0, mode);
    if (mode === 'persistent') assert.equal(actions.length, 0);
    else if (mode === 'stale') {
      assert.deepEqual(result, { skipped: 'page-identity-mismatch', preparedForClose: false });
      assert.deepEqual(actions, ['tabs']);
    } else assert.equal(result.preparedForClose, false);
  }
});

test('closeOwnedTab skips missing, browser-owned, and non-Xiaohongshu sessions', async () => {
  let calls = 0;
  const sendCommand = async () => { calls++; };
  assert.deepEqual(await closeOwnedTab({}, { sendCommand }), { skipped: 'no-adapter-session' });
  assert.deepEqual(await closeOwnedTab(page({ surface: 'browser' }), { sendCommand }), { skipped: 'not-adapter-surface' });
  assert.deepEqual(await closeOwnedTab(page({ surface: 'user' }), { sendCommand }), { skipped: 'not-adapter-surface' });
  assert.deepEqual(await closeOwnedTab(page({ session: 'browser:profile-1' }), { sendCommand }),
    { skipped: 'not-xiaohongshu-adapter-session' });
  assert.deepEqual(await closeOwnedTab(page({ session: 'site:xiaohongshu:' }), { sendCommand }),
    { skipped: 'not-xiaohongshu-adapter-session' });
  assert.equal(calls, 0);
});

test('normal one-shot adapters clean up on success and preserve the result if cleanup reporting throws', async () => {
  const closed = [];
  const wrapped = withOwnedTabCleanup(async (_page, _kwargs) => ({ published: true }), {
    close: async value => { closed.push(value); throw new Error('bridge cleanup failed'); },
    report: () => { throw new Error('diagnostic sink failed'); },
  });
  assert.deepEqual(await wrapped(page(), {}), { published: true });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].session, 'site:xiaohongshu:profile-1');
});

test('normal one-shot adapters preserve the original operation error over cleanup and diagnostics errors', async () => {
  const original = new Error('platform write outcome is unknown');
  let reports = 0;
  const wrapped = withOwnedTabCleanup(async () => { throw original; }, {
    close: async () => { throw new Error('bridge cleanup failed'); },
    report: () => { reports++; throw new Error('diagnostic sink failed'); },
  });
  await assert.rejects(wrapped(page(), {}), error => error === original);
  assert.equal(reports, 1);
});

for (const [name, kwargs] of [
  ['prepare-only boolean', { 'prepare-only': true }],
  ['prepare-only string', { 'prepare-only': 'true' }],
  ['keep-tab boolean', { 'keep-tab': true }],
  ['keepTab alias', { keepTab: true }],
]) {
  test(`explicit ${name} skips owned-tab cleanup`, async () => {
    let closes = 0;
    const wrapped = withOwnedTabCleanup(async () => 'prepared', { close: async () => { closes++; } });
    assert.equal(await wrapped(page(), kwargs), 'prepared');
    assert.equal(closes, 0);
  });
}

test('persistent browser sessions and runner keep-tab runtime signal are retained', async () => {
  let closes = 0;
  const persistent = withOwnedTabCleanup(async () => 'ok', {
    close: async () => { closes++; }, env: {},
  });
  const runtimeKeep = withOwnedTabCleanup(async () => 'ok', {
    close: async () => { closes++; },
    env: { REDNOTE_STEWARD_KEEP_TAB: '1' },
  });
  assert.equal(await persistent(page({ siteSession: 'persistent' }), {}), 'ok');
  assert.equal(await runtimeKeep(page(), {}), 'ok');
  assert.equal(closes, 0);
});

test('an explicitly false keep-tab signal still cleans up', async () => {
  let closes = 0;
  const wrapped = withOwnedTabCleanup(async () => 'ok', {
    close: async () => { closes++; },
    env: { REDNOTE_STEWARD_KEEP_TAB: '0' },
  });
  await wrapped(page(), { 'keep-tab': false, 'prepare-only': false });
  assert.equal(closes, 1);
});

test('runtime retention follows common options and resets inherited signals', async () => {
  const command = { args: [{name:'title',required:true}, {name:'content'}, {name:'prepare-only',type:'bool'}] };
  const env = { REDNOTE_STEWARD_KEEP_TAB: '1' };
  configureOwnedTabRetention(['xiaohongshu','edit-note','id','--keep-tab','true'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '1');
  configureOwnedTabRetention(['xiaohongshu','edit-note','id','--keep-tab=false'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '0');
  configureOwnedTabRetention(['xiaohongshu','edit-note','id','--site-session=persistent','--keep-tab','false'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '1');
  configureOwnedTabRetention(['xiaohongshu','edit-note','id','--title','--keep-tab','true'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '0');
  configureOwnedTabRetention(['xiaohongshu','edit-note','id','--','--keep-tab','true'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '0');
  configureOwnedTabRetention(['xiaohongshu','edit-note','id'], command, env);
  assert.equal(env.REDNOTE_STEWARD_KEEP_TAB, '0');
});
