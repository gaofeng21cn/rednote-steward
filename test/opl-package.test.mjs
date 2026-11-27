import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('OPL Package v2 declares RedNote entrypoints and all workspace views', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'opl-package.json'), 'utf8'));
  const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.schema_version, 'opl.package.v2');
  assert.match(packageMetadata.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(manifest.identity, {
    id: 'rednote-steward', version: packageMetadata.version, intent: 'extension',
    name: { 'zh-CN': 'RedNote Steward', 'en-US': 'RedNote Steward' },
    summary: {
      'zh-CN': '通过统一的本地 CLI 和 MCP 服务准备、审阅并管理小红书内容发布。',
      'en-US': 'Prepare, review and manage Xiaohongshu publications through one local CLI and MCP service.',
    },
    routing_summary: {
      'zh-CN': '检查发布队列、审阅准确内容、维护已有笔记，并从同一任务恢复执行。',
      'en-US': 'Inspect the publication queue, review exact content, maintain existing posts and resume the same task.',
    },
    publisher: 'gaofeng21cn', license: 'Apache-2.0',
    icon: 'assets/branding/rednote-steward-logo-v2.png',
    repository: 'https://github.com/gaofeng21cn/rednote-steward',
  });
  assert.equal(manifest.dependencies.opl_base, '^2.0.0');
  assert.deepEqual(manifest.dependencies.runtimes, [{ name: 'node', version: '>=24' }]);
  assert.deepEqual(manifest.provides.module_ids, ['rednote.steward.v1']);
  assert.deepEqual(manifest.provides.skills, [{ id: 'rednote-steward', path: './skills/rednote-steward', exposure: 'default' }]);
  assert.deepEqual(manifest.provides.contribution_handler, {
    kind: 'cli', argv: ['node', './scripts/run-plugin.mjs', 'app-contribution'],
    transport: 'stdin_json_stdout_json',
  });

  const views = manifest.ui.declarative.views;
  assert.deepEqual(views.map(view => view.id), [
    'rednote.steward.tasks', 'rednote.steward.review', 'rednote.steward.media',
    'rednote.steward.catalog', 'rednote.steward.history', 'rednote.steward.recovery',
  ]);
  for (const view of views) {
    assert.equal(view.slot, 'settings.section');
    assert.ok(['models', 'resources', 'workspace', 'capabilities', 'services', 'preferences'].includes(view.settings_destination));
  }
});
