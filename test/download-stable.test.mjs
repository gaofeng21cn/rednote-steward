import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { downloadStable } from '../scripts/download-stable.mjs';
const exec = promisify(execFile);
const hash = body => 'sha256:' + createHash('sha256').update(body).digest('hex');

async function fixture(t, { unsafe = false, corruptPayload = false, format = 'v1' } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-oci-fixture-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'rednote-steward');
  await fs.mkdir(path.join(root, 'src/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '1.2.3' }));
  await fs.writeFile(path.join(root, 'opl-package.json'), JSON.stringify({ schema_version: 'opl.package.v2',
    identity: { id: 'rednote-steward', version: '1.2.3' } }));
  await fs.writeFile(path.join(root, 'src/lib/build.mjs'), 'export async function createReleaseManifest(){return {version:"1.2.3"}}');
  await fs.writeFile(path.join(root, 'binary.png'), Buffer.from([0, 255, 129]));
  if (unsafe) await fs.symlink('/etc/passwd', path.join(root, 'outside'));
  const source = 'a'.repeat(40);
  const archive = path.join(temporary, 'source.tar.gz');
  const releasePaths = ['binary.png', 'opl-package.json', 'package.json', 'src/lib/build.mjs'];
  if (format === 'v2') {
    const entries = await Promise.all(releasePaths.map(async relative => [relative, await fs.readFile(path.join(root, relative))]));
    const hash = createHash('sha256');
    for (const [relative, bytes] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      const name = Buffer.from(relative), length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(name.length)); hash.update(length); hash.update(name);
      length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
    }
    const lock = { schema_version: 'opl.release.lock.v2', package_id: 'rednote-steward', version: '1.2.3',
      algorithm: 'sha256', canonicalization: 'ordered_path_length_file_length_bytes',
      file_count: releasePaths.length, paths: [...releasePaths].sort(), digest: 'sha256:' + hash.digest('hex'),
      built_at: '2026-11-28T00:00:00.000Z', git_commit: source };
    await fs.writeFile(path.join(root, 'opl-release.lock.json'), JSON.stringify(lock));
    await exec('tar', ['-czf', archive, '-C', root, ...releasePaths, 'opl-release.lock.json']);
  } else {
    await exec('tar', ['-czf', archive, '-C', temporary, 'rednote-steward']);
  }
  const descriptor = Buffer.from(JSON.stringify({ package_id: 'rednote-steward', version: '1.2.3', codex_surface: { carrier_source_commit: source } }));
  const payloadValue = format === 'v2'
    ? { package_format: 'v2', package_id: 'rednote-steward', package_version: '1.2.3', source_commit: source,
      source_repo: 'https://github.com/gaofeng21cn/rednote-steward.git', source_root: '.', archive_sha256: hash(await fs.readFile(archive)),
      file_count: releasePaths.length, content_lock: JSON.parse(await fs.readFile(path.join(root, 'opl-release.lock.json'), 'utf8')) }
    : { package_id: 'rednote-steward', package_version: '1.2.3', source_commit: source,
      source_repo: 'https://github.com/gaofeng21cn/rednote-steward.git', source_root: '.',
      files: [{ path: 'binary.png', sha256: hash(Buffer.from(corruptPayload ? [0] : [0, 255, 129])) }] };
  const payload = Buffer.from(JSON.stringify(payloadValue));
  const blobs = [descriptor, payload, await fs.readFile(archive)];
  const sourceKind = format === 'v2' ? 'source.v2+gzip' : 'source.v1+gzip';
  const layers = blobs.map((body, i) => ({ digest: hash(body), size: body.length, mediaType: 'application/vnd.onepersonlab.package.' + ['manifest.v1+json', 'payload.v1+json', sourceKind][i] }));
  const manifest = Buffer.from(JSON.stringify({ artifactType: 'application/vnd.onepersonlab.package.v1',
    annotations: { 'org.opencontainers.image.source': 'https://github.com/gaofeng21cn/rednote-steward' }, layers }));
  return { temporary, manifest, fetcher: async url => {
    if (url.includes('/token?')) return Response.json({ token: 'synthetic' });
    if (url.includes('/manifests/')) return new Response(manifest, { headers: { 'Docker-Content-Digest': hash(manifest) } });
    const index = layers.findIndex(item => url.endsWith(item.digest));
    assert.ok(index >= 0);
    return new Response(blobs[index]);
  } };
}

test('standalone installs use the same OCI version, commit and verified binary payload', async t => {
  const f = await fixture(t);
  const result = await downloadStable({ destination: path.join(f.temporary, 'stage'), fetcher: f.fetcher });
  assert.equal(result.version, '1.2.3');
  assert.equal(result.sourceRevision, 'a'.repeat(40));
  assert.deepEqual(await fs.readFile(path.join(result.source, 'binary.png')), Buffer.from([0, 255, 129]));
  await assert.rejects(downloadStable({ destination: path.join(f.temporary, 'other'), version: 'v1.2.4', fetcher: f.fetcher }), /identity differs/);
});

test('v2 source archives extract from package root and verify their release lock', async t => {
  const f = await fixture(t, { format: 'v2' });
  const result = await downloadStable({ destination: path.join(f.temporary, 'stage'), fetcher: f.fetcher });
  assert.equal(result.version, '1.2.3');
  assert.deepEqual(await fs.readFile(path.join(result.source, 'binary.png')), Buffer.from([0, 255, 129]));
  const lock = JSON.parse(await fs.readFile(path.join(result.source, 'opl-release.lock.json'), 'utf8'));
  assert.equal(lock.schema_version, 'opl.release.lock.v2');
  assert.equal((await fs.readdir(result.source)).includes('rednote-steward'), false);
});

test('corrupted OCI manifests are refused before creating the extraction directory', async t => {
  const f = await fixture(t), destination = path.join(f.temporary, 'stage');
  await assert.rejects(downloadStable({ destination, fetcher: async url => {
    if (url.includes('/manifests/')) return new Response(f.manifest, { headers: { 'Docker-Content-Digest': 'sha256:' + '0'.repeat(64) } });
    return f.fetcher(url);
  } }), /manifest digest differs/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('archive links cannot escape the private staging directory', async t => {
  const f = await fixture(t, { unsafe: true });
  await assert.rejects(downloadStable({ destination: path.join(f.temporary, 'stage'), fetcher: f.fetcher }), /regular files/);
});

test('payload file digests use the canonical prefixed format and reject changed bytes', async t => {
  const f = await fixture(t, { corruptPayload: true });
  await assert.rejects(downloadStable({ destination: path.join(f.temporary, 'stage'), fetcher: f.fetcher }), /Stable payload bytes differ: binary.png/);
});

test('the CLI executes through a symbolic script path as used by macOS temporary directories', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-oci-entry-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const link = path.join(temporary, 'download.mjs');
  await fs.symlink(await fs.realpath(new URL('../scripts/download-stable.mjs', import.meta.url)), link);
  await assert.rejects(exec(process.execPath, [link, 'relative-stage']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Use an absolute, new staging directory/);
    return true;
  });
});
