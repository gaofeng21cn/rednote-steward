#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repository = 'gaofeng21cn/one-person-lab-packages/rednote-steward';
const sourceRepository = 'https://github.com/gaofeng21cn/rednote-steward';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export async function downloadStable({ destination, version = 'latest-stable', fetcher = fetch }) {
  if (!path.isAbsolute(destination)) throw new Error('Use an absolute, new staging directory');
  const tag = version.replace(/^v(?=\d)/, '');
  if (tag !== 'latest-stable' && !/^\d+\.\d+\.\d+$/.test(tag)) throw new Error('Select latest-stable or an exact stable version');
  const request = async (url, headers = {}) => {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Stable Package download failed: HTTP ${response.status}`);
    return response;
  };
  const authorization = await (await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`)).json();
  const headers = { Authorization: `Bearer ${authorization.token}`, Accept: 'application/vnd.oci.image.manifest.v1+json' };
  const response = await request(`https://ghcr.io/v2/${repository}/manifests/${tag}`, headers);
  const manifestBytes = Buffer.from(await response.arrayBuffer());
  const manifestDigest = response.headers.get('Docker-Content-Digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest ?? '') || digest(manifestBytes) !== manifestDigest) throw new Error('Stable OCI manifest digest differs');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.artifactType !== 'application/vnd.onepersonlab.package.v1'
    || manifest.annotations?.['org.opencontainers.image.source'] !== sourceRepository) throw new Error('Unexpected stable Package source');
  const layer = kind => {
    const selected = manifest.layers.filter(item => item.mediaType === `application/vnd.onepersonlab.package.${kind}`);
    if (selected.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(selected[0].digest)) throw new Error('Invalid stable Package layers');
    return selected[0];
  };
  const blob = async item => {
    const bytes = Buffer.from(await (await request(`https://ghcr.io/v2/${repository}/blobs/${item.digest}`, headers)).arrayBuffer());
    if (bytes.length !== item.size || digest(bytes) !== item.digest) throw new Error('Stable Package layer digest differs');
    return bytes;
  };
  const [packageBytes, payloadBytes, archive] = await Promise.all([
    blob(layer('manifest.v1+json')), blob(layer('payload.v1+json')), blob(layer('source.v1+gzip')),
  ]);
  const descriptor = JSON.parse(packageBytes), payload = JSON.parse(payloadBytes);
  if (descriptor.package_id !== 'rednote-steward' || payload.package_id !== descriptor.package_id
    || payload.package_version !== descriptor.version || !/^\d+\.\d+\.\d+$/.test(descriptor.version)
    || (tag !== 'latest-stable' && descriptor.version !== tag)
    || !/^[a-f0-9]{40}$/.test(payload.source_commit)
    || descriptor.codex_surface?.carrier_source_commit !== payload.source_commit
    || payload.source_repo?.replace(/\.git$/, '') !== sourceRepository) throw new Error('Stable Package release identity differs');
  await fs.mkdir(destination); // Existing application and private state are never extraction targets.
  const archivePath = path.join(destination, 'source.tar.gz');
  await fs.writeFile(archivePath, archive);
  const listing = (await exec('tar', ['-tzf', archivePath], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n');
  const prefixes = new Set();
  for (const name of listing) {
    const parts = name.split('/');
    if (path.posix.isAbsolute(name) || parts.includes('..') || name.includes('\\')) throw new Error('Unsafe Package archive path');
    prefixes.add(parts[0]);
  }
  if (prefixes.size !== 1 || ![...prefixes][0]) throw new Error('Stable source archive must have one root');
  const verbose = (await exec('tar', ['-tvzf', archivePath], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n');
  if (verbose.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Stable source archive must contain regular files and directories');
  const source = path.join(destination, 'source');
  await fs.mkdir(source);
  await exec('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source]);
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json')));
  if (pkg.name !== 'rednote-steward' || pkg.version !== descriptor.version) throw new Error('Standalone and OCI versions differ');
  for (const entry of payload.files) {
    const relative = entry.path;
    if (path.posix.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\\')) throw new Error('Unsafe payload path');
    const bytes = await fs.readFile(path.join(source, payload.source_root ?? '.', relative));
    if (digest(bytes) !== entry.sha256) throw new Error(`Stable payload bytes differ: ${relative}`);
  }
  const { createReleaseManifest } = await import(pathToFileURL(path.join(source, 'src/lib/build.mjs')).href);
  const installation = await createReleaseManifest(source);
  installation.sourceRevision = payload.source_commit;
  installation.sourceDirty = false;
  await fs.writeFile(path.join(source, 'release-manifest.json'), JSON.stringify(installation, null, 2) + '\n');
  return { source, version: descriptor.version, sourceRevision: payload.source_commit, artifactDigest: manifestDigest };
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, version] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(await downloadStable({ destination, version })) + '\n');
}
