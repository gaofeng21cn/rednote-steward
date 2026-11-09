/**
 * Creator-center image/video publishing through OpenCLI Browser Bridge.
 * The DOM upload and component-submit approach follows OpenCLI 1.8.5
 * (Apache-2.0). This command adds a shared readback contract and one-submit
 * semantics. Video/cover controls are capability-checked before submission.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  validateTitle, validateBody, validateTopics, validateImages,
  waitFor, waitForEditor, readEditor, fillTitle, fillBody, replaceTopics,
  normalizeForComparison, sameTopics, IMAGE_INPUT_SELECTOR,
} from './editor-helpers.mjs';

const VIDEO_INPUT = 'input[type="file"][accept*="video"], input[type="file"][accept*=".mp4"], input[type="file"][accept*=".mov"]';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?from=menu_left';

export function validatePublishInput(kwargs) {
  const title = validateTitle(kwargs.title);
  const body = validateBody(kwargs.content);
  const topics = validateTopics(kwargs.topics);
  const images = validateImages(kwargs.images);
  const video = kwargs.video ? path.resolve(String(kwargs.video)) : null;
  const cover = kwargs.cover ? path.resolve(String(kwargs.cover)) : null;
  if (Boolean(video) === Boolean(images.length)) throw new ArgumentError('Supply either --images or --video');
  if (cover && !video) throw new ArgumentError('--cover belongs to a video package');
  if (video && (!fs.existsSync(video) || !fs.statSync(video).isFile())) throw new ArgumentError('Video file not found');
  if (video && !['.mp4', '.mov', '.m4v', '.webm'].includes(path.extname(video).toLowerCase())) throw new ArgumentError('Use an MP4, MOV, M4V or WebM video');
  if (cover) validateImages(cover);
  const timeoutSeconds = Number(kwargs['upload-timeout'] ?? 600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) throw new ArgumentError('upload-timeout must be 10–3600 seconds');
  return { title, body, topics, images, video, cover, timeoutMs: timeoutSeconds * 1000 };
}

export async function selectPublishSurface(page, kind) {
  await page.goto(`${PUBLISH_URL}&target=${kind}`);
  await page.wait({ time: 1 });
  const url = String(await page.evaluate('location.href'));
  if (/login|passport/i.test(url) || !url.startsWith('https://creator.xiaohongshu.com/')) throw new AuthRequiredError('creator.xiaohongshu.com');
  const selector = kind === 'video' ? VIDEO_INPUT : IMAGE_INPUT_SELECTOR;
  if (!await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
    const label = kind === 'video' ? '上传视频' : '上传图文';
    await page.evaluate(`(label => {
      const elements = Array.from(document.querySelectorAll('[role="tab"], .creator-tab, .tab, button'));
      const target = elements.find(el => el.offsetParent !== null && (el.innerText || '').trim() === label);
      if (!target) throw new Error('Publish tab unavailable: ' + label);
      target.click();
    })(${JSON.stringify(label)})`);
  }
  await waitFor(page, async () => Boolean(await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)), 15_000, 400, `${kind} file input`);
  return selector;
}

export async function attachFiles(page, files, selector) {
  if (typeof page.setFileInput !== 'function') throw new CommandExecutionError('Update OpenCLI Browser Bridge: local file upload is unavailable');
  // No retry after an ambiguous CDP upload. The controller retains the attempt.
  await page.setFileInput(files, selector);
}

export function uploadStateScript() {
  return `() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const errors = Array.from(document.querySelectorAll('[class*="upload"][class*="error"], [class*="upload"] [class*="error"]')).filter(visible).map(el => (el.innerText || '').trim()).filter(Boolean);
    const pending = Array.from(document.querySelectorAll('[class*="uploading"], [class*="upload"][class*="progress"], [class*="transcoding"]')).some(visible);
    const video = document.querySelector('video');
    const source = video?.currentSrc || video?.src || video?.querySelector('source')?.src || '';
    return { pending, errors, imageCount: document.querySelectorAll('.img-container').length,
      videoPresent: Boolean(source), videoDuration: video && Number.isFinite(video.duration) ? video.duration : null };
  }`;
}

async function waitForMedia(page, input) {
  let last;
  await waitFor(page, async () => {
    last = await page.evaluate(uploadStateScript());
    if (last?.errors?.length) throw new CommandExecutionError(last.errors.join('; '));
    return !last?.pending && (input.video ? last?.videoPresent : last?.imageCount === input.images.length);
  }, input.timeoutMs, 1000, 'media upload and processing');
  await waitForEditor(page);
  return last;
}

export async function applyCover(page, cover) {
  const opened = await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [class*="cover"] span, [class*="cover"] div'));
    const target = candidates.find(el => visible(el) && /^(编辑封面|修改封面|设置封面)$/.test((el.innerText || '').trim()));
    if (!target) return false;
    target.click(); return true;
  }`);
  if (!opened) throw new CommandExecutionError('The custom cover control is unavailable; the video remains unsubmitted');
  await page.wait({ time: 0.5 });
  await page.evaluate(`() => {
    const target = Array.from(document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="tab"], [class*="cover"] button, [class*="cover"] [class*="tab"]'))
      .find(el => el.offsetParent !== null && /^(上传封面|本地上传|上传图片)$/.test((el.innerText || '').trim()));
    if (target) target.click();
    return Boolean(target);
  }`);
  const selector = await page.evaluate(`() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]')).filter(el => el.offsetParent !== null);
    const inputs = dialogs.flatMap(el => Array.from(el.querySelectorAll('input[type="file"]'))).filter(el => /image|\\.jpg|\\.png/i.test(el.accept));
    if (inputs.length !== 1) return '';
    inputs[0].setAttribute('data-rednote-cover-input', 'true');
    return 'input[data-rednote-cover-input="true"]';
  }`);
  if (!selector) throw new CommandExecutionError('A unique custom cover file input was not exposed; the video remains unsubmitted');
  const previousSources = await page.evaluate(`() => {
    const dialog = document.querySelector('input[data-rednote-cover-input="true"]')?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    return Array.from(dialog?.querySelectorAll('img') || []).map(img => img.currentSrc || img.src || '');
  }`);
  await attachFiles(page, [cover], selector);
  await waitFor(page, async () => Boolean(await page.evaluate(`(previousSources => {
    const input = document.querySelector('input[data-rednote-cover-input="true"]');
    const dialog = input?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    return Boolean(dialog && Array.from(dialog.querySelectorAll('img')).some(img => img.complete && img.naturalWidth > 0 && !previousSources.includes(img.currentSrc || img.src || '')) && !dialog.querySelector('[class*="loading"], [class*="uploading"]'));
  })(${JSON.stringify(previousSources)})`)), 30_000, 500, 'custom cover preview');
  const selected = await page.evaluate(`() => {
    const input = document.querySelector('input[data-rednote-cover-input="true"]');
    const dialog = input?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    const button = Array.from(dialog?.querySelectorAll('button, [role="button"]') || []).find(el => !el.disabled && /^(确定|完成|保存)$/.test((el.innerText || '').trim()));
    if (!button) return null;
    const name = input?.files?.[0]?.name || '';
    button.click(); return { filename: name, confirmationClicked: true };
  }`);
  if (!selected || selected.filename !== path.basename(cover)) throw new CommandExecutionError('Custom cover selection could not be confirmed; the video remains unsubmitted');
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const dialog = document.querySelector('input[data-rednote-cover-input="true"]')?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    return !dialog || dialog.offsetParent === null;
  }`)), 10_000, 400, 'cover confirmation');
  return { ...selected, identityVerifiedAfterSave: false };
}

export async function submitOnce(page) {
  // Exactly one handler is selected. An exception after invocation is ambiguous,
  // so a second method or click is never attempted in the same call.
  return page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    const names = ['_onPublish', 'onPublish', '_onSubmit', '_handlePublish'];
    for (const host of Array.from(document.querySelectorAll('xhs-publish-btn')).filter(visible)) {
      for (const name of names) {
        if (typeof host[name] !== 'function') continue;
        if (host.disabled || host.hasAttribute('disabled') || host.getAttribute('aria-disabled') === 'true') throw new Error('Publish control is disabled');
        host[name](); return { invoked: true, via: name };
      }
    }
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const target = buttons.find(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && /^(发布|发布笔记)$/.test((el.innerText || '').trim()));
    if (!target) throw new Error('Publish control is unavailable');
    target.click(); return { invoked: true, via: 'button' };
  }`);
}

export async function publishNote(page, kwargs) {
  const input = validatePublishInput(kwargs);
  const selector = await selectPublishSurface(page, input.video ? 'video' : 'image');
  await attachFiles(page, input.video ? [input.video] : input.images, selector);
  const media = await waitForMedia(page, input);
  const cover = input.cover ? await applyCover(page, input.cover) : null;
  await fillTitle(page, input.title);
  await fillBody(page, input.body);
  await replaceTopics(page, input.topics);
  const prepared = await readEditor(page);
  if (!prepared || prepared.title !== input.title || normalizeForComparison(prepared.body) !== normalizeForComparison(input.body) || !sameTopics(prepared.topics, input.topics) || prepared.topics.some(topic => !topic.id)) {
    throw new CommandExecutionError('Composer title, body or native topic nodes do not match the requested package');
  }
  const invocation = await submitOnce(page);
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const url = new URL(location.href);
    return url.origin === 'https://creator.xiaohongshu.com' &&
      (['/publish/publishSuccess', '/publish/success'].includes(url.pathname) ||
        Boolean(Array.from(document.querySelectorAll('[class*="success"]')).find(el => el.offsetParent !== null && /发布成功/.test(el.innerText || ''))));
  }`)), 30_000, 500, 'publish confirmation');
  return [{ status: 'submitted', title: input.title, mediaType: input.video ? 'video' : 'image',
    imageCount: input.images.length, topics: prepared.topics, media, cover, invocation,
    verification: 'submission-confirmed; saved fields require same-note readback' }];
}

cli({
  site: 'xiaohongshu', name: 'steward-publish',
  description: 'Publish an image or video package through the creator UI with native topics',
  access: 'write', domain: 'creator.xiaohongshu.com', strategy: Strategy.COOKIE,
  browser: true, navigateBefore: false,
  args: [
    { name: 'content', positional: true, required: true, help: 'Body without topic hashtags' },
    { name: 'title', required: true, help: 'Title, at most 20 characters' },
    { name: 'images', help: 'Comma-separated image paths in display order' },
    { name: 'video', help: 'Local video file; mutually exclusive with images' },
    { name: 'cover', help: 'Custom video cover image' },
    { name: 'topics', help: 'Comma-separated exact native topic names' },
    { name: 'upload-timeout', type: 'int', default: 600, help: 'Upload/processing timeout in seconds' },
  ],
  columns: ['status', 'title', 'mediaType', 'imageCount', 'topics', 'media', 'cover', 'invocation', 'verification'],
  func: publishNote,
});
