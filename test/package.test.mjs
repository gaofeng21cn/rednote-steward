import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectPackage, normalizeText, unicodeLength } from '../src/lib/package.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function fixture(t, changes = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-package-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'image.png'), png);
  const raw = { schemaVersion: 1, account: 'demo', kind: 'publish', title: '城市随记', body: '街角遇到一家旧书店。', topics: ['城市漫步'], images: ['image.png'], ...changes };
  await fs.writeFile(path.join(dir, 'post.json'), JSON.stringify(raw));
  return dir;
}
test('normalizes comparison whitespace and counts Unicode code points', () => {
  assert.equal(normalizeText('  a  \r\n\r\n b\t'), 'a\n\nb'); assert.equal(unicodeLength('旅行🥹'), 3);
});
test('hashes media bytes and retains user paragraph formatting', async t => {
  const dir = await fixture(t, { body: 'First paragraph\nSecond line\n\nLast paragraph' });
  const inspected = await inspectPackage(dir);
  assert.equal(inspected.body, 'First paragraph\nSecond line\n\nLast paragraph');
  assert.equal(inspected.imageCount, 1); assert.match(inspected.images[0].sha256, /^[a-f0-9]{64}$/);
});
test('requires an explicit account alias', async t => {
  const dir = await fixture(t, { account: undefined });
  await assert.rejects(() => inspectPackage(dir), /account is required/);
});
test('rejects a renamed unsupported image container', async t => {
  const dir = await fixture(t); await fs.writeFile(path.join(dir,'image.png'), 'not a PNG');
  await assert.rejects(() => inspectPackage(dir), /must contain JPEG, PNG or WebP/);
});
test('allows an intentional empty native-topic selection without guessing from hashtags', async t => {
  const dir = await fixture(t, { topics: [], body: 'A caption #plain-text' });
  const inspected = await inspectPackage(dir);
  assert.deepEqual(inspected.topics, []); assert.equal(inspected.warnings.length, 1);
});
test('publish needs media; edits may preserve media and an empty body', async t => {
  const empty = await fixture(t, { images: [] });
  await assert.rejects(() => inspectPackage(empty), /at least one image or a video/);
  const edit = await fixture(t, { kind: 'edit', images: [], body: '', sourceNoteId: '000000000000000000000001' });
  assert.equal((await inspectPackage(edit)).body, '');
});
test('video, cover and subtitles are fingerprinted; a new version links to the original note', async t => {
  const dir = await fixture(t, { images: [], video: 'clip.mp4', cover: 'image.png', subtitle: 'captions.srt', replacesNoteId: '000000000000000000000001' });
  await fs.writeFile(path.join(dir, 'clip.mp4'), Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));
  await fs.writeFile(path.join(dir, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,000\nExample\n');
  const first = await inspectPackage(dir);
  assert.equal(first.mediaType,'video'); assert.equal(first.replacesNoteId,'000000000000000000000001');
  await fs.appendFile(path.join(dir,'clip.mp4'), 'changed');
  assert.notEqual((await inspectPackage(dir)).fingerprint, first.fingerprint);
});
test('rejects mixed image/video packages and accepts video edits', async t => {
  const mixed = await fixture(t, { video:'clip.mp4' });
  await assert.rejects(() => inspectPackage(mixed), /Choose video or images/);
  const edit = await fixture(t, { kind:'edit', sourceNoteId:'000000000000000000000001', images:[], video:'clip.mp4' });
  await fs.writeFile(path.join(edit,'clip.mp4'), Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));
  const inspected = await inspectPackage(edit);
  assert.equal(inspected.kind,'edit');
  assert.equal(inspected.mediaType,'video');
  assert.equal(inspected.sourceNoteId,'000000000000000000000001');
});

test('accepts a cover-only edit while rejecting cover plus image replacement', async t => {
  const coverOnly = await fixture(t, { kind: 'edit', sourceNoteId: '000000000000000000000001', images: [], cover: 'image.png' });
  const inspected = await inspectPackage(coverOnly);
  assert.equal(inspected.cover.name, 'image.png');
  assert.equal(inspected.video, null);
  assert.equal(inspected.mediaType, 'video');
  const mixed = await fixture(t, { kind: 'edit', sourceNoteId: '000000000000000000000001', cover: 'image.png' });
  await fs.writeFile(path.join(mixed, 'second.png'), png);
  await fs.writeFile(path.join(mixed, 'post.json'), JSON.stringify({
    account: 'demo', kind: 'edit', sourceNoteId: '000000000000000000000001', title: '城市随记',
    body: '街角遇到一家旧书店。', topics: [], images: ['second.png'], cover: 'image.png',
  }));
  await assert.rejects(() => inspectPackage(mixed), /cover-only edit cannot replace images/);
});
