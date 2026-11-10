import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('plugin dependency preparation is isolated, serialized and leaves stdout to the entrypoint', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.copyFile(path.join(project, 'scripts/run-plugin.mjs'), path.join(root, 'scripts/run-plugin.mjs'));
  const pkg = { name: 'rednote-steward', version: '0.2.3', dependencies: {} };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
  await fs.writeFile(path.join(root, 'src/cli.mjs'), 'console.log(JSON.stringify({ok:true,args:process.argv.slice(2)}));\n');
  const run = () => exec(process.execPath, [path.join(root, 'scripts/run-plugin.mjs'), 'cli', 'status'], { timeout: 30_000 });
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.deepEqual(JSON.parse(result.stdout), { ok: true, args: ['status'] });
  assert.equal(results.filter(result => result.stderr.includes('Preparing RedNote')).length, 1);
  assert.match(await fs.readFile(path.join(root, 'node_modules/.rednote-lock-digest'), 'utf8'), /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(path.join(root, '.rednote-runtime-lock')), { code: 'ENOENT' });
  assert.equal((await run()).stderr, '');
});
