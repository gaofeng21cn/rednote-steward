#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReleaseManifest, buildIdentity } from '../src/lib/build.mjs';
import { verifyContentLock } from './package-lock.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const destination = argument('--out');
if (!destination || !path.isAbsolute(destination)) throw new Error('Use --out with an absolute artifact directory outside the source tree');
const out = path.resolve(destination);
if (out === root || out.startsWith(root + path.sep)) throw new Error('Release artifacts belong outside the source tree');
const { stdout: dirty } = await exec('git', ['status', '--porcelain'], { cwd: root });
if (dirty.trim()) throw new Error('Commit the exact release inputs before building a release');
verifyContentLock(root);
const qualificationPath = argument('--qualification');
const qualification = qualificationPath ? JSON.parse(await fs.readFile(qualificationPath, 'utf8')) : [];
if (!Array.isArray(qualification)) throw new Error('Qualification evidence must be an array');
const manifest = await createReleaseManifest(root, { qualification });
if (!manifest.sourceRevision || manifest.sourceDirty !== false) throw new Error('A clean source revision is required');
const tag = `v${manifest.version}`;
const prefix = `rednote-steward-${tag}`;
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-release-'));
await fs.mkdir(out, { recursive: true });
try {
  const archive = path.join(stage, 'source.tar');
  await exec('git', ['archive', `--prefix=${prefix}/`, '--format=tar', '-o', archive, manifest.sourceRevision], { cwd: root });
  await exec('tar', ['-xf', archive, '-C', stage]);
  const source = path.join(stage, prefix);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(source, 'release-manifest.json'), manifestBytes);
  const identity = await buildIdentity(source);
  if (!identity.manifest.matched || identity.sourceRevision !== manifest.sourceRevision) throw new Error('Staged release does not match the committed manifest');
  const tarballName = `${prefix}.tar.gz`;
  const tarball = path.join(stage, tarballName);
  await exec('tar', ['-czf', tarball, '-C', stage, prefix]);
  const archiveBytes = await fs.readFile(tarball);
  const checksum = createHash('sha256').update(archiveBytes).digest('hex');
  // An existing release name may be reused only when its exact bytes agree.
  for (const [name, bytes] of [[tarballName, archiveBytes], ['release-manifest.json', manifestBytes], ['SHA256SUMS', Buffer.from(`${checksum}  ${tarballName}\n`)]]) {
    const target = path.join(out, name);
    try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await fs.readFile(target)).equals(bytes)) throw new Error(`Release artifact already exists with different bytes: ${name}`);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, tag, sourceRevision: manifest.sourceRevision, contentDigest: manifest.content.digest,
    archive: path.join(out, tarballName), sha256: checksum, manifest: path.join(out, 'release-manifest.json') }, null, 2) + '\n');
} finally { await fs.rm(stage, { recursive: true, force: true }); }
