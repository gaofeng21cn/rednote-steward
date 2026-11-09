import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('standard MCP handshake, tools, resources and shared CLI account state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-mcp-'));
  const fake = path.join(dir, 'fake-opencli');
  await fs.copyFile(path.join(root, 'test/fixtures/fake-opencli.mjs'), fake);
  await fs.chmod(fake, 0o700);
  const platformState = path.join(dir, 'synthetic-platform.json');
  const env = { ...process.env, XHS_OPS_HOME: path.join(dir, 'private data'), XHS_OPS_OWNER_HOME: path.join(dir, 'owners'),
    XHS_OPS_OPENCLI_BIN: fake, FAKE_OPENCLI_STATE: platformState,
    FAKE_USER_ID: '000000000000000000000001', FAKE_PUBLISH_DELAY: '300' };
  const client = new Client({ name: 'rednote-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'src/mcp.mjs')], env, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'rednote-steward');
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'task_execute'));
    assert.ok(tools.tools.some((tool) => tool.name === 'task_reconcile'));
    const resources = await client.listResources();
    assert.ok(resources.resources.some((r) => r.uri === 'rednote://capabilities'));
    const capabilities = await client.readResource({ uri: 'rednote://capabilities' });
    assert.equal(JSON.parse(capabilities.contents[0].text).transport, 'stdio');
    const bound = await client.callTool({ name: 'account_bind', arguments: {
      account: 'demo', userId: '000000000000000000000001', profile: 'demo-profile', name: 'Demo author',
    } });
    assert.notEqual(bound.isError, true, JSON.stringify(bound));
    const { stdout } = await exec(process.execPath, [path.join(root, 'src/cli.mjs'), 'account', 'list'], { env });
    assert.equal(JSON.parse(stdout).accounts[0].alias, 'demo');
    const list = await client.callTool({ name: 'accounts_list', arguments: {} });
    assert.equal(list.structuredContent.accounts[0].alias, 'demo');
    const rejected = await client.callTool({ name: 'package_inspect', arguments: { path: './relative/post.json' } });
    assert.equal(rejected.isError, true);
    await fs.copyFile(path.join(root, 'examples/image-post/sample.png'), path.join(dir, 'sample.png'));
    const manifest = path.join(dir, 'post.json');
    await fs.writeFile(manifest, JSON.stringify({ account: 'demo', kind: 'publish',
      title: 'Synthetic sample', body: 'An integration fixture.', topics: [], images: ['sample.png'] }));
    const imported = await client.callTool({ name: 'package_ingest', arguments: { path: manifest } });
    const taskId = imported.structuredContent.taskId;
    assert.ok(taskId, JSON.stringify(imported));
    const reviewed = await client.callTool({ name: 'task_review', arguments: { taskId } });
    assert.equal(reviewed.structuredContent.items[0].task_id, taskId);
    const exact = reviewed.structuredContent.items[0];
    const authorized = await client.callTool({ name: 'task_authorize', arguments: {
      taskId, authorization: 'Publish the synthetic fixture through the fake adapter.',
      fingerprint: exact.fingerprint, revision: exact.revision,
    } });
    assert.notEqual(authorized.isError, true, JSON.stringify(authorized));
    const started = await client.callTool({ name: 'task_execute', arguments: { taskId } });
    assert.equal(started.structuredContent.status, 'worker_started');
    await client.close();
    // A client disconnect must not lose a live upload or trigger resubmission.
    let task;
    for (let attempt = 0; attempt < 60; attempt++) {
      const output = await exec(process.execPath, [path.join(root, 'src/cli.mjs'), 'show', taskId], { env });
      task = JSON.parse(output.stdout).task;
      if (['verified', 'failed', 'needs_review', 'submitted'].includes(task.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(task.state, 'verified', JSON.stringify(task));
    assert.equal(JSON.parse(await fs.readFile(platformState, 'utf8')).writes, 1);
    // Reopen the client and operate the same owner through the new management
    // surfaces. Local organization must not turn into another publication.
    const second = new Client({ name: 'rednote-management-test', version: '1.0.0' });
    try {
      await second.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root,'src/mcp.mjs')], env, stderr: 'pipe' }));
      const sync = await second.callTool({ name: 'catalog_sync', arguments: { account: 'demo', limit: 10 } });
      assert.equal(sync.structuredContent.publicationTasksCreated, 0);
      const id = task.platform_note_id;
      const organized = await second.callTool({ name: 'catalog_update', arguments: { account: 'demo', noteId: id,
        seriesId: 'synthetic-travel', episode: '01', contentType: 'travel', maintenanceStatus: 'keep', reason: 'The original discovery is already clear.' } });
      assert.notEqual(organized.isError, true, JSON.stringify(organized));
      const series = await second.callTool({ name: 'series_define', arguments: { account: 'demo', seriesId: 'synthetic-travel', title: 'Synthetic trip', expectedEpisodes: ['01','02'] } });
      assert.deepEqual(series.structuredContent.series[0].missingEpisodes, ['02']);
      const catalog = await second.callTool({ name: 'catalog_list', arguments: { account: 'demo', status: 'keep' } });
      assert.equal(catalog.structuredContent.notes[0].note_id, id);
      const history = await second.callTool({ name: 'metrics_history', arguments: { account: 'demo', noteId: id } });
      assert.deepEqual(history.structuredContent.observations, []);
      const copied = await second.callTool({ name: 'state_backup', arguments: { destination: path.join(dir, 'backup') } });
      assert.notEqual(copied.isError, true, JSON.stringify(copied));
      const restoreTarget = path.join(dir, 'restored');
      const preview = await second.callTool({ name: 'state_restore', arguments: { backupPath: path.join(dir,'backup'), target: restoreTarget } });
      assert.notEqual(preview.isError, true, JSON.stringify(preview));
      await assert.rejects(fs.stat(restoreTarget), { code: 'ENOENT' });
      const futureManifest = path.join(dir, 'future.json');
      await fs.writeFile(futureManifest, JSON.stringify({ account: 'demo', title: 'Future fixture', body: 'Not due yet.', topics: [], images: ['sample.png'] }));
      const future = await second.callTool({ name: 'package_ingest', arguments: { path: futureManifest } });
      const futureId = future.structuredContent.taskId;
      await second.callTool({ name: 'task_authorize', arguments: { taskId: futureId, authorization: 'Synthetic future fixture.', at: '2099-01-01T00:00:00Z' } });
      await second.callTool({ name: 'task_execute', arguments: { taskId: futureId } });
      let failedLaunch;
      for (let attempt = 0; attempt < 40; attempt++) {
        const observed = await second.callTool({ name: 'task_get', arguments: { taskId: futureId } });
        failedLaunch = observed.structuredContent.task;
        if (failedLaunch.worker_launch?.status === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(failedLaunch.state, 'queued');
      assert.equal(failedLaunch.worker_launch.status, 'failed');
      assert.match(failedLaunch.worker_launch.error, /scheduled/);
      assert.equal(JSON.parse(await fs.readFile(platformState, 'utf8')).writes, 1);
    } finally { await second.close(); }
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
