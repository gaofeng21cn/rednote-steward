import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { validatePublishInput, attachFiles, submitOnce, selectPublishSurface, uploadStateScript } from '../adapters/opencli/xiaohongshu/steward-publish.js';
import { creatorIdentityScript, readCreatorIdentity } from '../adapters/opencli/xiaohongshu/steward-account.js';
import { sameTopics, replaceVideo } from '../adapters/opencli/xiaohongshu/editor-helpers.mjs';
import { videoSourceChanged } from '../src/lib/media.mjs';
import { getRegistry } from '@jackwener/opencli/registry';
import '../adapters/opencli/xiaohongshu/inventory.js';
import '../adapters/opencli/xiaohongshu/edit-note.js';

function evaluate(source, context = {}) {
  const result = vm.runInNewContext(`(${source})`, context);
  return typeof result === 'function' ? result() : result;
}

test('publish rejects mixed media and cover without video before browser use', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-adapters-'));
  try {
    const image = path.join(dir, 'cover.png');
    const video = path.join(dir, 'video.mp4');
    await fs.writeFile(image, 'synthetic image');
    await fs.writeFile(video, 'synthetic video');
    const args = { title: 'A walk', content: 'A quiet morning', topics: '旅行' };
    assert.throws(() => validatePublishInput({ ...args, images: image, video }), /either/);
    assert.throws(() => validatePublishInput({ ...args, images: image, cover: image }), /belongs/);
    assert.throws(() => validatePublishInput({ ...args, video, 'upload-timeout': 0 }), /timeout/);
    const actual = validatePublishInput({ ...args, video, cover: image });
    assert.equal(actual.video, video);
    assert.equal(actual.cover, image);
    assert.equal(actual.timeoutMs, 600_000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('unknown upload failure never retries attachment', async () => {
  let calls = 0;
  const page = { setFileInput: async () => { calls++; throw new Error('Bridge connection lost'); } };
  await assert.rejects(attachFiles(page, ['/synthetic/video.mp4'], 'input'), /connection lost/);
  assert.equal(calls, 1);
});

test('a throwing submit handler never triggers another method or click', async () => {
  const calls = [];
  const host = {
    offsetParent: {}, getBoundingClientRect: () => ({ width: 120 }),
    hasAttribute: () => false, getAttribute: () => null,
    _onPublish: () => { calls.push('first'); throw new Error('ambiguous submit'); },
    onPublish: () => calls.push('second'),
  };
  const page = { evaluate: source => evaluate(source, { document: { querySelectorAll: selector => selector === 'xhs-publish-btn' ? [host] : [{ click: () => calls.push('button') }] } }) };
  await assert.rejects(submitOnce(page), /ambiguous submit/);
  assert.deepEqual(calls, ['first']);
});

test('native topics need exact names and platform IDs; empty removes all', () => {
  assert.equal(sameTopics([{ id: 'topic-1', name: '旅行' }], ['旅行']), true);
  assert.equal(sameTopics([{ name: '旅行' }], ['旅行']), false);
  assert.equal(sameTopics([{ id: 'topic-1', name: '#旅行' }], ['旅行']), false);
  assert.equal(sameTopics([], []), true);
  assert.equal(sameTopics([{ id: 'topic-1', name: '旅行' }], []), false);
});

test('account identity uses creator response stable ID, never nickname', async () => {
  const identity = await evaluate(creatorIdentityScript(), { fetch: async () => ({ ok: true, json: async () => ({ data: { name: 'Example Creator', user_id: '0123456789abcdef01234567' } }) }) });
  assert.equal(identity.userId, '0123456789abcdef01234567');
  assert.equal(identity.identitySource, 'creator-personal-info');
  await assert.rejects(readCreatorIdentity({ goto: async () => {}, evaluate: async () => ({ logged_in: true, username: 'Example Creator', userId: '' }) }), /stable user ID/);
});

test('creator UI ID is accepted only when linked to the fresh server account', async () => {
  const context = {
    fetch: async () => ({ ok: true, json: async () => ({ data: { name: 'Example Creator', red_num: '123456789' } }) }),
    localStorage: { getItem: () => JSON.stringify({ userName: 'Example Creator', redId: '123456789', userId: '0123456789abcdef01234567' }) },
  };
  const identity = await evaluate(creatorIdentityScript(), context);
  assert.equal(identity.userId, '0123456789abcdef01234567');
  assert.equal(identity.identitySource, 'creator-profile-linked-state');
  context.localStorage.getItem = () => JSON.stringify({ userName: 'Example Creator', redId: '987654321', userId: '0123456789abcdef01234567' });
  const stale = await evaluate(creatorIdentityScript(), context);
  assert.equal(stale.userId, '');
  assert.equal(stale.identitySource, 'unresolved');
});

test('surface selection invokes only the exact requested upload tab', async () => {
  let hasInput = false;
  const clicked = [];
  const tab = { offsetParent: {}, innerText: '上传视频', click() { clicked.push('video'); hasInput = true; } };
  const document = { querySelector: () => hasInput ? {} : null, querySelectorAll: () => [tab] };
  const page = { goto: async () => {}, wait: async () => {}, evaluate: source => evaluate(source, { document, location: { href: 'https://creator.xiaohongshu.com/publish/publish' } }) };
  const selector = await selectPublishSurface(page, 'video');
  assert.match(selector, /video/);
  assert.deepEqual(clicked, ['video']);
});

test('media readiness requires actual video source, not an empty element', () => {
  const document = { querySelector: () => ({ src: '', currentSrc: '', duration: NaN, querySelector: () => null }), querySelectorAll: () => [] };
  const state = evaluate(uploadStateScript(), { document });
  assert.equal(state.videoPresent, false);
  assert.equal(state.videoDuration, null);
});

test('inventory accepts a genuinely empty creator account', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', [], { found: false }, true];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  assert.deepEqual(await command.func(page, { limit: 30 }), []);
});

test('inventory does not mistake a missing page or login for an empty account', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', [], { found: false }, false];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  await assert.rejects(command.func(page, { limit: 30 }), /No creator note cards loaded/);
});

function videoEditor({ inputCount = 1, uploadError = null, image = false } = {}) {
  const title = { offsetParent: {}, value: 'Example' };
  const body = { offsetParent: {}, querySelectorAll: () => [] };
  const video = { currentSrc: 'https://example.invalid/old.mp4', duration: 65.13 };
  const input = { accept: '.mp4', files: [], setAttribute() {} };
  const context = { location: { href: 'https://creator.xiaohongshu.com/publish/update' }, document: {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('placeholder')) return [title];
      if (selector.includes('tiptap')) return [body];
      if (selector === 'input[type="file"]') return Array(inputCount).fill(input);
      return [];
    },
    querySelector(selector) {
      if (selector === 'video') return image ? null : video;
      if (selector === '.img-container') return image ? {} : null;
      if (selector.includes('tiptap')) return body;
      if (selector.includes('data-steward-video-replacement')) return input;
      return null;
    },
  } };
  let uploads = 0;
  const page = {
    goto: async url => { context.location.href = url; }, wait: async () => {},
    evaluate: source => evaluate(source, context),
    async setFileInput(files) {
      uploads++;
      if (uploadError) throw new Error(uploadError);
      const stat = await fs.stat(files[0]);
      input.files = [{ name: path.basename(files[0]), size: stat.size }];
      video.currentSrc = 'blob:prepared-video';
    },
  };
  return { page, uploads: () => uploads, context };
}

test('video replacement selects one native input once and retains preparation evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-video-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4');
  await fs.writeFile(video, 'synthetic video');
  const editor = videoEditor();
  const evidence = await replaceVideo(editor.page, video);
  assert.equal(editor.uploads(), 1);
  assert.equal(evidence.selectedFile.name, 'clip.mp4');
  assert.equal(evidence.before.src, 'https://example.invalid/old.mp4');
  assert.equal(evidence.prepared.src, 'blob:prepared-video');
  const ambiguous = videoEditor({ inputCount: 2 });
  await assert.rejects(replaceVideo(ambiguous.page, video), /unavailable/);
  assert.equal(ambiguous.uploads(), 0);
  const lost = videoEditor({ uploadError: 'Connection lost after upload' });
  await assert.rejects(replaceVideo(lost.page, video), /Connection lost/);
  assert.equal(lost.uploads(), 1);
});

test('video edit rejects an image target before changing its fields or media', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-target-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4');
  await fs.writeFile(video, 'synthetic video');
  const editor = videoEditor({ image: true });
  const command = getRegistry().get('xiaohongshu/edit-note');
  await assert.rejects(command.func(editor.page, { 'note-id': '000000000000000000000001',
    title: 'Example', content: 'Caption', video }), /existing video note/);
  assert.equal(editor.uploads(), 0);
  assert.match(editor.context.location.href, /noteType=video/);
});

test('renewed CDN signatures and blob previews do not prove a changed saved video', () => {
  const original = 'https://example.invalid/video.mp4?signature=old';
  assert.equal(videoSourceChanged(original, 'https://example.invalid/video.mp4?signature=new'), false);
  assert.equal(videoSourceChanged(original, 'https://other-cdn.invalid/video.mp4'), false);
  assert.equal(videoSourceChanged(original, 'blob:prepared-video'), false);
  assert.equal(videoSourceChanged(original, 'https://example.invalid/revised.mp4'), true);
});
