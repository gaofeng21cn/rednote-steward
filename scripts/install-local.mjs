import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import { publicContentDigest } from '../src/lib/build.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
for (const name of ['--source', '--root', '--bin', '--node']) {
  if (!args.includes(name) || !value(name) || value(name).startsWith('--')) throw new Error(`Missing ${name}`);
}
const source = path.resolve(value('--source'));
const root = path.resolve(value('--root'));
const bin = path.resolve(value('--bin'));
const node = path.resolve(value('--node'));
const stateRoot = path.resolve(process.env.XHS_OPS_HOME || path.join(os.homedir(), '.local/share/rednote-steward'));
const stat = await fs.stat(root).catch(() => null);
const markerFile = path.join(root, 'install.json');
let previous = null;
try { previous = JSON.parse(await fs.readFile(markerFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (stat && !previous && (await fs.readdir(root)).length > 0) throw new Error('Installation directory contains unrelated files. Choose an empty XHS_OPS_INSTALL_ROOT.');
if (previous && (previous.product !== 'rednote-steward' || previous.root !== root)) throw new Error('Installation directory has a different owner.');
if (root === path.parse(root).root || root === source || bin === root) throw new Error('Use separate application and command directories.');

const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
if (pkg.name !== 'rednote-steward') throw new Error('Source package is not RedNote Steward.');
const manifest = await fs.readFile(path.join(source, 'release-manifest.json'), 'utf8').then(value => JSON.parse(value)).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (manifest && (manifest.schemaVersion !== 1 || manifest.product !== 'rednote-steward' || manifest.version !== pkg.version)) {
  throw new Error('Release manifest identity does not match this package.');
}
const sourceRevision = manifest?.sourceRevision || null;
const expectedContentDigest = manifest?.content?.digest || null;
const actualContent = await publicContentDigest(source);
const contentDigest = actualContent.digest;
if (expectedContentDigest && expectedContentDigest !== contentDigest) {
  throw new Error(`Release manifest content digest does not match source files: expected ${expectedContentDigest}, observed ${contentDigest}`);
}
const versionDir = path.join(root, 'releases', `${pkg.version}-${Date.now()}`);
await fs.mkdir(path.dirname(versionDir), { recursive: true });
// Rename on the same device when possible; copying supports a separate /tmp volume.
try { await fs.rename(source, versionDir); }
catch (error) {
  if (error.code !== 'EXDEV') throw error;
  await fs.cp(source, versionDir, { recursive: true });
}
await fs.writeFile(path.join(versionDir, '.install-location.json'), `${JSON.stringify({ product: 'rednote-steward', root, bin }, null, 2)}\n`);

const current = path.join(root, 'current');
const oldCurrent = await fs.readlink(current).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const temporaryLink = path.join(root, `current-${process.pid}`);
await fs.symlink(versionDir, temporaryLink, 'dir');
await fs.rename(temporaryLink, current);
await fs.mkdir(bin, { recursive: true });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const wrappers = [];
const wrapperSnapshots = [];
for (const [name, entry] of [['xhs-ops', 'src/cli.mjs'], ['rednote-steward-mcp', 'src/mcp.mjs']]) {
  const target = path.join(bin, name);
  let backup = previous?.wrappers?.find((item) => item.path === target)?.backup || null;
  let originalLink = previous?.wrappers?.find((item) => item.path === target)?.originalLink || null;
  const targetStat = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const old = await fs.readFile(target, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  wrapperSnapshots.push({ target, content: old, mode: targetStat?.mode, link: targetStat?.isSymbolicLink() ? await fs.readlink(target) : null });
  const oldRecord = previous?.wrappers?.find((item) => item.path === target);
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  if ((old || targetStat?.isSymbolicLink()) && (!oldRecord || oldRecord.sha256 !== sha(old || ''))) {
    if (old) {
      backup = path.join(root, 'backups', `${name}-${Date.now()}`);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(target, backup);
    }
    originalLink = targetStat?.isSymbolicLink() ? await fs.readlink(target) : null;
  }
  const content = `#!/bin/sh\n# rednote-steward managed command\nexport XHS_OPS_INSTALL_ROOT=${quote(root)}\nexport XHS_OPS_BIN_DIR=${quote(bin)}\nif [ -z "\${XHS_OPS_HOME:-}" ]; then export XHS_OPS_HOME=${quote(stateRoot)}; fi\nexec ${quote(node)} ${quote(path.join(current, entry))} "$@"\n`;
  const pending = `${target}.rednote-${process.pid}`;
  await fs.writeFile(pending, content, { mode: 0o755 });
  await fs.rename(pending, target);
  await fs.chmod(target, 0o755);
  wrappers.push({ path: target, sha256: sha(content), backup, originalLink });
}
const record = { product: 'rednote-steward', root, bin, node, stateRoot, version: pkg.version,
  sourceRevision, sourceDirty: manifest?.sourceDirty ?? null, contentDigest,
  releaseManifest: manifest ? { generatedAt: manifest.generatedAt ?? null, browserBridge: manifest.browserBridge ?? null } : null,
  current: versionDir, wrappers, installedAt: new Date().toISOString() };
await fs.writeFile(markerFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
const setupFlags = ['--skill', '--mcp', '--browser-extension'].filter((flag) => args.includes(flag));
let setupResult;
try {
  const result = await exec(node, [path.join(current, 'src/cli.mjs'), 'setup', ...setupFlags], {
    env: { ...process.env, XHS_OPS_INSTALL_ROOT: root, XHS_OPS_BIN_DIR: bin }, timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  setupResult = JSON.parse(result.stdout);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} catch (error) {
  let report = null;
  try { report = JSON.parse(error.stdout); } catch { /* A setup crash has no report. */ }
  if (report?.checks?.every((check) => check.ok) && report.integrations) {
    // A missing browser download or a conflicting client entry is actionable
    // setup output. Keep the working program available for setup --repair.
    setupResult = report;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (oldCurrent) {
      await fs.symlink(oldCurrent, temporaryLink, 'dir');
      await fs.rename(temporaryLink, current);
    } else await fs.rm(current, { force: true });
    for (const snapshot of wrapperSnapshots) {
      await fs.rm(snapshot.target, { force: true });
      if (snapshot.link) await fs.symlink(snapshot.link, snapshot.target);
      else if (snapshot.content != null) await fs.writeFile(snapshot.target, snapshot.content, { mode: snapshot.mode });
    }
    await fs.writeFile(markerFile, `${JSON.stringify(previous || { ...record, current: null, wrappers: [], failedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    throw new Error(`Setup failed; the previous commands and application selection were restored. ${error.stderr || error.message}`);
  }
}
process.stdout.write(`${JSON.stringify({ ok: true, integrationsReady: setupResult.ok, version: pkg.version, sourceRevision,
  contentDigest, application: current, commands: wrappers.map((item) => item.path) }, null, 2)}\n`);
