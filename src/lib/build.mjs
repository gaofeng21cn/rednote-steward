import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BRIDGE_RELEASE = {
  version: '1.0.26',
  url: 'https://github.com/jackwener/OpenCLI/releases/download/v2.0.2/opencli-extension-v1.0.26.zip',
  sha256: '2b2eff46fe4a21a0b02516e743005066e6317b48f15455c1c7b07f69ad7af211',
};
const PUBLIC_INPUTS = ['package.json', 'package-lock.json', 'src', 'adapters', 'skills', 'scripts',
  'install.sh', 'LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'docs', 'assets', 'examples',
  'opl-package.json', 'app-contribution-adapter.json', 'plugin.json', '.codex-plugin'];

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** Hash public install inputs only; personal state, dependencies and the manifest are excluded. */
export async function publicContentDigest(root = PACKAGE_ROOT) {
  const entries = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = await fs.lstat(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Public package input must not be a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) entries.push(relative.split(path.sep).join('/'));
  }
  for (const name of PUBLIC_INPUTS) await visit(name);
  const hash = createHash('sha256');
  for (const name of [...new Set(entries)].sort()) {
    const bytes = await fs.readFile(path.join(root, name));
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return { algorithm: 'sha256', canonicalization: 'ordered_path_length_file_length_bytes',
    digest: `sha256:${hash.digest('hex')}`, files: entries.length };
}

async function gitSource(root) {
  try {
    const [{ stdout: revision }, { stdout: dirty }] = await Promise.all([
      exec('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5000 }),
      exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { timeout: 5000 }),
    ]);
    return { sourceRevision: revision.trim(), sourceDirty: Boolean(dirty.trim()) };
  } catch { return { sourceRevision: null, sourceDirty: null }; }
}

export async function buildIdentity(root = PACKAGE_ROOT) {
  const pkg = await readJson(path.join(root, 'package.json'), {});
  const manifest = await readJson(path.join(root, 'release-manifest.json'));
  const content = await publicContentDigest(root);
  const git = await gitSource(root);
  const manifestMatches = Boolean(manifest && manifest.schemaVersion === 1 && manifest.product === 'rednote-steward' &&
    manifest.version === pkg.version && manifest.content?.digest === content.digest);
  return { product: pkg.name || 'rednote-steward', version: pkg.version || null,
    sourceRevision: git.sourceRevision || (manifestMatches ? manifest.sourceRevision : null),
    sourceDirty: git.sourceRevision ? git.sourceDirty : manifestMatches ? manifest.sourceDirty : null,
    content, manifest: manifest ? { present: true, matched: manifestMatches,
      digest: `sha256:${createHash('sha256').update(await fs.readFile(path.join(root, 'release-manifest.json'))).digest('hex')}`,
      generatedAt: manifest.generatedAt || null } : { present: false, matched: false, digest: null },
    dependencies: pkg.dependencies || {}, browserBridge: BRIDGE_RELEASE,
    qualification: manifestMatches ? manifest.qualification || [] : [],
  };
}

export async function createReleaseManifest(root = PACKAGE_ROOT, { qualification = [] } = {}) {
  const identity = await buildIdentity(root);
  return { schemaVersion: 1, product: 'rednote-steward', version: identity.version,
    sourceRevision: identity.sourceRevision, sourceDirty: identity.sourceDirty,
    generatedAt: new Date().toISOString(), content: identity.content,
    dependencies: identity.dependencies, browserBridge: BRIDGE_RELEASE, qualification };
}
