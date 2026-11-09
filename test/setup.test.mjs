import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setup } from '../src/setup.mjs';
import { createReleaseManifest } from '../src/lib/build.mjs';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote setup '));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source');
  for (const name of ['src/lib', 'adapters/opencli', 'node_modules/@jackwener/opencli', 'skills/rednote-steward', 'scripts']) {
    await fs.mkdir(path.join(sourceRoot, name), { recursive: true });
  }
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '0.1.0', type: 'module' }));
  await fs.writeFile(path.join(sourceRoot, 'node_modules/@jackwener/opencli/package.json'), '{}');
  await fs.writeFile(path.join(sourceRoot, 'src/opencli-runner.mjs'), '');
  await fs.writeFile(path.join(sourceRoot, 'src/mcp.mjs'), '');
  await fs.copyFile(path.join(project, 'src/lib/build.mjs'), path.join(sourceRoot, 'src/lib/build.mjs'));
  await fs.writeFile(path.join(sourceRoot, 'skills/rednote-steward/SKILL.md'), 'Generic workflow\n');
  return { base, sourceRoot, stateRoot: path.join(base, 'private state'), codexRoot: path.join(base, 'codex'), installRoot: path.join(base, "app's install $(literal)"), binDir: path.join(base, "command's bin") };
}

test('setup preserves and restores a user skill; repeated setup keeps its original backup', async (t) => {
  const p = await fixture(t);
  const target = path.join(p.codexRoot, 'skills/rednote-steward/SKILL.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'User workflow\n');
  const first = await setup({ ...p, skill: true });
  assert.equal(first.ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'Generic workflow\n');
  const again = await setup({ ...p, skill: true });
  assert.equal(again.integrations.skill.status, 'current');
  const removed = await setup({ ...p, uninstall: true });
  assert.equal(removed.changes[0].status, 'restored');
  assert.equal(await fs.readFile(target, 'utf8'), 'User workflow\n');
});

test('uninstall preserves post-install user edits and private database', async (t) => {
  const p = await fixture(t);
  await setup({ ...p, skill: true });
  const target = path.join(p.codexRoot, 'skills/rednote-steward/SKILL.md');
  await fs.writeFile(target, 'A later user edit\n');
  const database = path.join(p.stateRoot, 'xhs-ops.sqlite');
  await fs.writeFile(database, 'private state');
  const removed = await setup({ ...p, uninstall: true });
  assert.equal(removed.kept.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'A later user edit\n');
  assert.equal(await fs.readFile(database, 'utf8'), 'private state');
});

test('missing Codex returns portable MCP configuration without changing client settings', async (t) => {
  const p = await fixture(t);
  const result = await setup({ ...p, mcp: true, codexCommand: path.join(p.base, 'missing-codex') });
  assert.equal(result.integrations.mcp.status, 'manual');
  assert.equal(result.integrations.mcp.config.mcpServers['rednote-steward'].command, process.execPath);
  await assert.rejects(fs.stat(p.codexRoot), { code: 'ENOENT' });
  const receipt = JSON.parse(await fs.readFile(path.join(p.stateRoot, 'installation.json'), 'utf8'));
  assert.equal(receipt.version, '0.1.0');
  assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.browserBridge.version, '1.0.26');
});

test('MCP name collision leaves the existing client entry untouched', async (t) => {
  const p = await fixture(t);
  const command = path.join(p.base, 'fake-codex');
  await fs.writeFile(command, `#!${process.execPath}\nif(process.argv[3] !== 'get') process.exit(9);\nconsole.log(JSON.stringify({transport:{command:'/other/server',args:[]}}));\n`, { mode: 0o755 });
  const result = await setup({ ...p, mcp: true, codexCommand: command });
  assert.equal(result.ok, false);
  assert.equal(result.integrations.mcp.status, 'conflict');
});

test('installation wrappers handle spaces and quotes; uninstall restores a foreign symlink and retains state', async (t) => {
  const p = await fixture(t);
  await fs.copyFile(path.join(project, 'src/setup.mjs'), path.join(p.sourceRoot, 'src/setup.mjs'));
  await fs.copyFile(path.join(project, 'scripts/uninstall.mjs'), path.join(p.sourceRoot, 'scripts/uninstall.mjs'));
  await fs.writeFile(path.join(p.sourceRoot, 'src/cli.mjs'), `import {setup} from './setup.mjs';\nif(process.argv[2]==='setup') console.log(JSON.stringify(await setup({}))); else console.log(JSON.stringify(process.argv.slice(2)));\n`);
  await fs.mkdir(p.binDir, { recursive: true });
  const original = path.join(p.base, 'previous-tool');
  await fs.writeFile(original, '#!/bin/sh\nprintf previous\\n\n');
  await fs.symlink(original, path.join(p.binDir, 'xhs-ops'));
  const env = { ...process.env, XHS_OPS_HOME: p.stateRoot };
  await exec(process.execPath, [path.join(project, 'scripts/install-local.mjs'), '--source', p.sourceRoot, '--root', p.installRoot, '--bin', p.binDir, '--node', process.execPath], { env });
  assert.equal(await fs.readFile(original, 'utf8'), '#!/bin/sh\nprintf previous\\n\n');
  const { stdout } = await exec(path.join(p.binDir, 'xhs-ops'), ['literal $(hello)', "a'b"], { env });
  assert.deepEqual(JSON.parse(stdout), ['literal $(hello)', "a'b"]);
  await fs.mkdir(p.stateRoot, { recursive: true });
  const database = path.join(p.stateRoot, 'xhs-ops.sqlite');
  await fs.writeFile(database, 'keep account data');
  await exec(process.execPath, [path.join(p.installRoot, 'current/scripts/uninstall.mjs')], { env });
  assert.equal(await fs.readlink(path.join(p.binDir, 'xhs-ops')), original);
  assert.equal(await fs.readFile(database, 'utf8'), 'keep account data');
  await assert.rejects(fs.stat(path.join(p.installRoot, 'current')), { code: 'ENOENT' });
});

test('a failed upgrade restores the previous application and commands', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(path.join(p.sourceRoot, 'src/cli.mjs'), `console.log(JSON.stringify({ok:true,version:'working'}));\n`);
  const env = { ...process.env, XHS_OPS_HOME: p.stateRoot };
  const installerArgs = ['--root', p.installRoot, '--bin', p.binDir, '--node', process.execPath];
  await exec(process.execPath, [path.join(project, 'scripts/install-local.mjs'), '--source', p.sourceRoot, ...installerArgs], { env });
  const previous = await fs.readlink(path.join(p.installRoot, 'current'));
  const broken = path.join(p.base, 'broken source');
  await fs.mkdir(path.join(broken, 'src'), { recursive: true });
  await fs.writeFile(path.join(broken, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '0.1.1', type: 'module' }));
  await fs.writeFile(path.join(broken, 'src/cli.mjs'), `throw new Error('broken setup');\n`);
  await assert.rejects(exec(process.execPath, [path.join(project, 'scripts/install-local.mjs'), '--source', broken, ...installerArgs], { env }), /previous commands and application selection were restored/);
  assert.equal(await fs.readlink(path.join(p.installRoot, 'current')), previous);
  const { stdout } = await exec(path.join(p.binDir, 'xhs-ops'), ['help'], { env });
  assert.equal(JSON.parse(stdout).version, 'working');
});

test('installer verifies manifest bytes before selecting a release and records source identity', async t => {
  const p = await fixture(t);
  await fs.writeFile(path.join(p.sourceRoot, 'src/cli.mjs'), `console.log(JSON.stringify({ok:true,version:'working'}));\n`);
  const manifest = await createReleaseManifest(p.sourceRoot);
  manifest.sourceRevision = 'b'.repeat(40);
  manifest.sourceDirty = false;
  const manifestFile = path.join(p.sourceRoot, 'release-manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, content: { ...manifest.content, digest: 'sha256:' + '0'.repeat(64) } }));
  const env = { ...process.env, XHS_OPS_HOME: p.stateRoot };
  const args = [path.join(project, 'scripts/install-local.mjs'), '--source', p.sourceRoot, '--root', p.installRoot, '--bin', p.binDir, '--node', process.execPath];
  await assert.rejects(exec(process.execPath, args, { env }), /content digest does not match/);
  await assert.rejects(fs.stat(path.join(p.installRoot, 'current')), { code: 'ENOENT' });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await exec(process.execPath, args, { env });
  const receipt = JSON.parse(await fs.readFile(path.join(p.installRoot, 'install.json'), 'utf8'));
  assert.equal(receipt.sourceRevision, manifest.sourceRevision);
  assert.equal(receipt.contentDigest, manifest.content.digest);
  assert.equal(receipt.sourceDirty, false);
});
