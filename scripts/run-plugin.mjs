#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = { cli: 'src/cli.mjs', mcp: 'src/mcp.mjs', 'app-contribution': 'src/app-contribution.mjs' };
const run = (command, args, stdio) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio });
  const forward = signal => { child.kill(signal); };
  const terminate = () => forward('SIGTERM'), interrupt = () => forward('SIGINT');
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  const clear = () => { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); };
  child.once('error', error => { clear(); reject(error); });
  child.once('exit', (code, signal) => { clear(); resolve(code ?? (signal ? 1 : 0)); });
});

async function ready(pkg, digest) {
  try {
    if (await fs.readFile(path.join(root, 'node_modules/.rednote-lock-digest'), 'utf8') !== digest) return false;
    for (const [name, version] of Object.entries(pkg.dependencies || {})) {
      const observed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (observed.name !== name || observed.version !== version) return false;
    }
    return true;
  } catch { return false; }
}

async function prepare() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'rednote-steward') throw new Error('Plugin runtime identity is invalid.');
  const digest = createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex');
  if (await ready(pkg, digest)) return;
  const lock = path.join(root, '.rednote-runtime-lock');
  const deadline = Date.now() + 180_000;
  while (true) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
      if (owner > 0) {
        try { process.kill(owner, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { await fs.rm(lock, { recursive: true, force: true }); continue; } }
      }
      if (await ready(pkg, digest)) return;
      if (Date.now() > deadline) throw new Error('Plugin dependency setup is still running. Retry after it completes.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  try {
    await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
    if (await ready(pkg, digest)) return;
    process.stderr.write('Preparing RedNote Steward plugin dependencies from its package lock.\n');
    const code = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', root], ['ignore', 2, 2]);
    if (code !== 0) throw new Error('Plugin dependency setup failed. Check Node.js, npm and registry access, then retry.');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/.rednote-lock-digest'), digest);
    if (!await ready(pkg, digest)) throw new Error('Plugin dependencies do not match the package lock.');
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

const [entry = 'mcp', ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(entries, entry)) throw new Error('Choose cli, mcp or app-contribution.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('RedNote Steward requires Node.js 24 or newer.');
  await prepare();
  process.exitCode = await run(process.execPath, [path.join(root, entries[entry]), ...args], 'inherit');
} catch (error) {
  process.stderr.write(`RedNote Steward: ${error.message}\n`);
  process.exitCode = 1;
}
