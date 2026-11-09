import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function verifyContentLock(root, write = false) {
  const file = path.join(root, 'opl-package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const digest = createHash('sha256');
  for (const relative of manifest.content_lock.paths) {
    const name = Buffer.from(relative), bytes = fs.readFileSync(path.join(root, relative));
    for (const value of [name, bytes]) {
      const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(value.length));
      digest.update(length); digest.update(value);
    }
  }
  const expected = `sha256:${digest.digest('hex')}`;
  if (write) { manifest.content_lock.digest = expected; fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`); }
  else if (manifest.content_lock.digest !== expected) throw new Error('Package content lock differs; run npm run lock:package after reviewing source changes.');
  return expected;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(verifyContentLock(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write')));
}
