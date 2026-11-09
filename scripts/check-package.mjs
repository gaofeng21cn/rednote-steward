#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packOutput = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
// npm versions emit either an array with one pack record or an object keyed
// by package name. Accept both so the release check is portable across Node/npm
// versions used by contributors and CI.
const pack = Array.isArray(packOutput)
  ? packOutput[0]
  : packOutput[Object.keys(packOutput)[0]];
const allowed = /^(src\/|adapters\/|skills\/|examples\/|scripts\/|docs\/|assets\/|install\.sh$|package\.json$|README(?:\.zh-CN)?\.md$|LICENSE$|NOTICE$)/;
const privateFile = /(?:^|\/)(?:\.state|receipts|workers|cookies|accounts\.json|browser-profiles\.json|\.env(?:\..*)?)(?:\/|$)|\.(?:sqlite(?:-[\w]+)?|db|log)$/i;
const localPath = /\/(?:Users|home)\/[a-zA-Z][\w.-]+\//;
const credential = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const errors = [];
for (const file of pack.files) {
  if (!allowed.test(file.path) || privateFile.test(file.path)) errors.push(`Unexpected package entry: ${file.path}`);
}
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isSymbolicLink()) { errors.push(`Source symlink requires review: ${relative}`); continue; }
    if (entry.isDirectory()) { visit(absolute); continue; }
    if (entry.name.endsWith('.tgz')) continue;
    if (privateFile.test(relative)) errors.push(`Private runtime file in source: ${relative}`);
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (localPath.test(text)) errors.push(`Personal home path in source: ${relative}`);
    if (credential.test(text)) errors.push(`Credential-shaped value in source: ${relative}`);
  }
}
visit(root);
for (const required of ['src/cli.mjs', 'src/mcp.mjs', 'src/opencli-runner.mjs', 'install.sh',
  'LICENSE', 'NOTICE', 'skills/rednote-steward/SKILL.md']) {
  if (!pack.files.some((file) => file.path === required)) errors.push(`Missing package entry: ${required}`);
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ ok: true, name: pack.name, version: pack.version,
    files: pack.files.length, unpackedSize: pack.unpackedSize }) + '\n');
}
