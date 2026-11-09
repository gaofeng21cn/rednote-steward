import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function call(file, args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, file), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => {
      try { resolve({ code, json: JSON.parse(stdout || stderr), stderr }); } catch { reject(new Error(`${code}: ${stdout}\n${stderr}`)); }
    });
    child.stdin.end(stdin);
  });
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, XHS_OPS_HOME: path.join(dir, 'state'),
    XHS_OPS_OPENCLI_BIN: path.join(root, 'test/fixtures/fake-opencli.mjs'), FAKE_OPENCLI_STATE: path.join(dir, 'platform.json') };
  const cli = args => call('src/cli.mjs', args, env);
  const read = (ref = 'tasks', input = {}, operation = 'read') => call('src/app-contribution.mjs', [], env,
    JSON.stringify({ schema_version: 'opl-package-app-contribution-request.v1', operation, ref: `rednote.steward.v1#${ref}`, input }));
  async function task() {
    assert.equal((await cli(['account', 'add', 'demo', '--user-id', 'demo-user-001', '--profile', 'demo-profile'])).code, 0);
    await fs.copyFile(path.join(root, 'examples/image-post/sample.png'), path.join(dir, 'image.png'));
    await fs.writeFile(path.join(dir, 'post.json'), JSON.stringify({ account: 'demo', title: 'Exact task', body: 'Synthetic content.', topics: ['城市漫步'], images: ['image.png'] }));
    const result = await cli(['ingest', dir]); assert.equal(result.code, 0, result.stderr); return result.json.taskId;
  }
  return { dir, env, cli, read, task };
}

test('review discovery is read-only on a fresh install and rejects execute', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.read()).json.result.data.items, []);
  await assert.rejects(fs.stat(f.env.XHS_OPS_HOME), { code: 'ENOENT' });
  assert.equal((await f.read('review')).json.result.state, 'input_required');
  assert.equal((await f.read('tasks', {}, 'execute')).json.ok, false);
});

test('CLI and contribution share exact content, media refs and conditional authorization', async t => {
  const f = await fixture(t), id = await f.task();
  const item = (await f.cli(['review', id])).json.items[0];
  const shared = (await f.read('review', { task_id: id, fingerprint: item.fingerprint, revision: item.revision })).json;
  assert.deepEqual(shared.result.data.items[0], item);
  assert.equal(item.artifacts[0].artifact_ref, path.join(f.dir, 'image.png'));
  assert.match(item.artifacts[0].revision, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(item.preview.after.topics, ['城市漫步']);
  assert.equal(item.source_state.state, 'current');
  assert.equal((await f.read('review', { task_id: id, account: 'foreign' })).json.ok, false);
  assert.equal((await f.read('review', { task_id: id, fingerprint: 'wrong' })).json.ok, false);
  const approved = await f.cli(['approve', id, '--fingerprint', item.fingerprint, '--revision', item.revision, '--authorization', 'Synthetic request']);
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal((await f.read('review', { task_id: id, revision: item.revision })).json.ok, false);
  const stale = await f.cli(['approve', id, '--revision', item.revision]);
  assert.equal(stale.code, 1); assert.match(stale.json.error, /revision changed/);
  await assert.rejects(fs.stat(f.env.FAKE_OPENCLI_STATE), { code: 'ENOENT' });
});

test('source changes mark frozen assets unavailable instead of presenting new bytes as reviewed', async t => {
  const f = await fixture(t), id = await f.task();
  await fs.appendFile(path.join(f.dir, 'image.png'), 'changed');
  const item = (await f.read('media', { task_id: id })).json.result.data.items[0];
  assert.equal(item.source_state.state, 'stale');
  assert.equal(item.artifacts[0].availability, 'unavailable');
  assert.equal((await f.cli(['show', id])).json.task.state, 'draft');
});

test('reopening unknown and reconciled outcomes observes the same task without resubmission', async t => {
  const f = await fixture(t), id = await f.task();
  await f.cli(['approve', id]);
  const run = await call('src/cli.mjs', ['run', id], { ...f.env, FAKE_MODE: 'unknown' });
  assert.equal(run.json.state, 'needs_review');
  const before = JSON.parse(await fs.readFile(f.env.FAKE_OPENCLI_STATE, 'utf8')).writes;
  for (let n = 0; n < 2; n++) {
    const item = (await f.read('review', { task_id: id })).json.result.data.items[0];
    assert.equal(item.status, 'needs_review');
    assert.equal(item.publication_evidence.submission, 'outcome_unknown');
    assert.match(item.next_action.summary, /reconcile/);
  }
  assert.equal((await f.cli(['reconcile', id])).json.state, 'verified');
  const item = (await f.read('review', { task_id: id })).json.result.data.items[0];
  assert.equal(item.publication_evidence.fields, 'matched');
  assert.equal(item.publication_evidence.public_visibility, 'not_evaluated');
  assert.equal(item.readback.noteId, item.target.platform_note_id);
  assert.equal(JSON.parse(await fs.readFile(f.env.FAKE_OPENCLI_STATE, 'utf8')).writes, before);
});
