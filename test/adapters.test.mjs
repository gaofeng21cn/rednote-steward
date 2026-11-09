import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { validatePublishInput, attachFiles, submitOnce, selectPublishSurface, uploadStateScript } from '../adapters/opencli/xiaohongshu/steward-publish.js';
import { creatorIdentityScript, readCreatorIdentity } from '../adapters/opencli/xiaohongshu/steward-account.js';
import { sameTopics } from '../adapters/opencli/xiaohongshu/editor-helpers.mjs';
import { getRegistry } from '@jackwener/opencli/registry';
import '../adapters/opencli/xiaohongshu/inventory.js';

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
