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

async function fixture(t, { unsafe = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-oci-fixture-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'rednote-steward');
  await fs.mkdir(path.join(root, 'src/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'rednote-steward', version: '1.2.3' }));
  await fs.writeFile(path.join(root, 'src/lib/build.mjs'), 'export async function createReleaseManifest(){return {version:"1.2.3"}}');
  await fs.writeFile(path.join(root, 'binary.png'), Buffer.from([0, 255, 129]));
  if (unsafe) await fs.symlink('/etc/passwd', path.join(root, 'outside'));
  const archive = path.join(temporary, 'source.tar.gz');
  await exec('tar', ['-czf', archive, '-C', temporary, 'rednote-steward']);
  const source = 'a'.repeat(40);
  const descriptor = Buffer.from(JSON.stringify({ package_id: 'rednote-steward', version: '1.2.3', codex_surface: { carrier_source_commit: source } }));
  const payload = Buffer.from(JSON.stringify({ package_id: 'rednote-steward', package_version: '1.2.3', source_commit: source,
    source_repo: 'https://github.com/gaofeng21cn/rednote-steward.git', source_root: '.',
    files: [{ path: 'binary.png', sha256: createHash('sha256').update(Buffer.from([0, 255, 129])).digest('hex') }] }));
  const blobs = [descriptor, payload, await fs.readFile(archive)];
  const layers = blobs.map((body, i) => ({ digest: hash(body), size: body.length, mediaType: 'application/vnd.onepersonlab.package.' + ['manifest.v1+json', 'payload.v1+json', 'source.v1+gzip'][i] }));
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
