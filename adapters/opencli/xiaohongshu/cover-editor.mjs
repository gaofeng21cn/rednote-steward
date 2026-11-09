import * as path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { waitFor } from './editor-helpers.mjs';

export async function attachFiles(page, files, selector) {
  if (typeof page.setFileInput !== 'function') throw new CommandExecutionError('Update OpenCLI Browser Bridge: local file upload is unavailable');
  // No retry after an ambiguous CDP upload. The controller retains the attempt.
  await page.setFileInput(files, selector);
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
