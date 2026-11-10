import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installationStatus } from '../src/lib/installation.mjs';
import { createReleaseManifest } from '../src/lib/build.mjs';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-managed-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const installRoot = path.join(base, 'app'), bin = path.join(base, 'bin'), state = path.join(base, 'private');
  return { base, installRoot, bin, state, env: { ...process.env, XHS_OPS_HOME: state, XHS_OPS_INSTALL_ROOT: installRoot } };
}
async function install(p, version) {
  const source = path.join(p.base, `source-${version}`);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'rednote-steward', version, type: 'module' }));
  await fs.writeFile(path.join(source, 'src/cli.mjs'), 'console.log(JSON.stringify({ok:true}));\n');
  await fs.writeFile(path.join(source, 'src/mcp.mjs'), '');
  await fs.writeFile(path.join(source, 'src/setup.mjs'), 'export async function setup(){ return { dataPreserved: true }; }\n');
  await fs.copyFile(path.join(project, 'scripts/uninstall.mjs'), path.join(source, 'scripts/uninstall.mjs'));
  const manifest = await createReleaseManifest(source);
  manifest.sourceRevision = 'a'.repeat(40);
  await fs.writeFile(path.join(source, 'release-manifest.json'), JSON.stringify(manifest));
  await exec(process.execPath, [path.join(project, 'scripts/install-local.mjs'), '--source', source,
    '--root', p.installRoot, '--bin', p.bin, '--node', process.execPath], { env: p.env });
  return fs.realpath(path.join(p.installRoot, 'current'));
}

test('native installation readback follows selected version and never reads private state', async t => {
  const p = await fixture(t);
  assert.equal((await installationStatus(p)).status, 'not_installed');
  await install(p, '0.2.3');
  const first = await installationStatus(p);
  assert.equal(first.status, 'ready');
  assert.equal(first.installed_version, '0.2.3');
  assert.equal(first.source_revision, 'a'.repeat(40));
  assert.equal(first.update_status, 'not_checked');
  assert.equal(JSON.stringify(first).includes(p.base), false);
  await assert.rejects(fs.stat(p.state), { code: 'ENOENT' });
  await install(p, '0.2.4');
  const next = await installationStatus(p);
  assert.equal(next.installed_version, '0.2.4');
  assert.notEqual(next.revision, first.revision);
});

test('changed content, commands or selection cannot be reported as a healthy installation', async t => {
  const p = await fixture(t);
  const selected = await install(p, '0.2.3');
  const command = path.join(p.bin, 'xhs-ops');
  const original = await fs.readFile(command);
  await fs.writeFile(command, 'user-modified-command');
  assert.equal((await installationStatus(p)).reason, 'installation_commands_changed');
  await fs.writeFile(command, original);
  await fs.appendFile(path.join(selected, 'src/cli.mjs'), '// changed\n');
  assert.equal((await installationStatus(p)).reason, 'installation_content_changed');
  const receiptFile = path.join(p.installRoot, 'install.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, current: p.base }));
  assert.equal((await installationStatus(p)).reason, 'installation_selection_mismatch');
});

test('an old release cannot uninstall the current one; current uninstall retains private data', async t => {
  const p = await fixture(t);
  const first = await install(p, '0.2.3');
  const current = await install(p, '0.2.4');
  await fs.mkdir(p.state, { recursive: true });
  await fs.writeFile(path.join(p.state, 'keep.txt'), 'preserved');
  await assert.rejects(exec(process.execPath, [path.join(first, 'scripts/uninstall.mjs')], { env: p.env }), /currently selected installation/);
  assert.equal(await fs.realpath(path.join(p.installRoot, 'current')), current);
  await exec(process.execPath, [path.join(current, 'scripts/uninstall.mjs')], { env: p.env });
  assert.equal((await installationStatus(p)).status, 'not_installed');
  assert.equal(await fs.readFile(path.join(p.state, 'keep.txt'), 'utf8'), 'preserved');
});

test('installation CLI status is read-only and excludes private paths', async t => {
  const p = await fixture(t);
  const { stdout } = await exec(process.execPath, [path.join(project, 'src/cli.mjs'), 'installation', 'status', '--json'], { env: p.env });
  const result = JSON.parse(stdout);
  assert.equal(result.package_id, 'rednote-steward');
  assert.equal(result.status, 'not_installed');
  assert.equal(stdout.includes(p.base), false);
  await assert.rejects(fs.stat(p.state), { code: 'ENOENT' });
});
