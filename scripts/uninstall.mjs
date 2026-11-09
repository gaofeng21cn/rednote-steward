import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setup } from '../src/setup.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const location = JSON.parse(await fs.readFile(path.join(appRoot, '.install-location.json'), 'utf8'));
const root = path.resolve(location.root);
const realRoot = await fs.realpath(root);
if (location.product !== 'rednote-steward' || root === path.parse(root).root) throw new Error('Unrecognized installation location.');
const record = JSON.parse(await fs.readFile(path.join(root, 'install.json'), 'utf8'));
if (record.product !== 'rednote-steward' || record.root !== root || !appRoot.startsWith(`${realRoot}${path.sep}releases${path.sep}`)) {
  throw new Error('Installation ownership could not be verified.');
}
const integrations = await setup({ uninstall: true, installRoot: root, binDir: record.bin, stateRoot: record.stateRoot });
const commands = [];
for (const item of record.wrappers) {
  const content = await fs.readFile(item.path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!content) continue;
  if (createHash('sha256').update(content).digest('hex') !== item.sha256) {
    commands.push({ path: item.path, status: 'kept_modified' });
  } else if (item.originalLink) {
    const pending = `${item.path}.restore-${process.pid}`;
    await fs.symlink(item.originalLink, pending);
    await fs.rename(pending, item.path);
    commands.push({ path: item.path, status: 'restored' });
  } else if (item.backup) {
    await fs.copyFile(item.backup, item.path);
    commands.push({ path: item.path, status: 'restored' });
  } else {
    await fs.unlink(item.path);
    commands.push({ path: item.path, status: 'removed' });
  }
}
// Keep extension files: Chrome may still load this version. Keep backups as a
// recovery route. Remove only this installer's code releases and current link.
await fs.rm(path.join(root, 'current'), { force: true });
await fs.rm(path.join(root, 'releases'), { recursive: true, force: true });
await fs.writeFile(path.join(root, 'install.json'), `${JSON.stringify({ ...record, uninstalledAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: true, integrations, commands, dataPreserved: integrations.dataPreserved, retained: ['browser-bridge', 'backups'] }, null, 2)}\n`);
