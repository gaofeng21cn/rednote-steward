#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity, createReleaseManifest } from '../src/lib/build.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--source');
const root = rootIndex < 0 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.resolve(args[rootIndex + 1]);
const outIndex = args.indexOf('--out');
const target = outIndex < 0 ? path.join(root, 'release-manifest.json') : path.resolve(args[outIndex + 1]);
if (args.includes('--check')) {
  const identity = await buildIdentity(root);
  if (!identity.manifest.matched) throw new Error('The release manifest is missing or does not match these public package bytes.');
  process.stdout.write(`${JSON.stringify({ ok: true, ...identity })}\n`);
} else {
  const qualificationIndex = args.indexOf('--qualification');
  const qualification = qualificationIndex < 0 ? [] : JSON.parse(await fs.readFile(path.resolve(args[qualificationIndex + 1]), 'utf8'));
  if (!Array.isArray(qualification)) throw new Error('Qualification evidence must be an array.');
  const manifest = await createReleaseManifest(root, { qualification });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, path: target, version: manifest.version, sourceRevision: manifest.sourceRevision,
    sourceDirty: manifest.sourceDirty, digest: manifest.content.digest })}\n`);
}
