import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { applyDeclarations, readDeclarations, validateDeclarations } from '../adapters/opencli/xiaohongshu/declarations.mjs';

function fixture(specs = [], { confirmationDialog = false } = {}) {
  let clicks = 0, evaluations = 0, dialog = false;
  const labels = specs.map(({ text, checked = false, disabled = false }) => {
    const control = { offsetParent: {}, checked, disabled,
      matches: () => true, getAttribute: () => null,
      click() { clicks++; this.checked = !this.checked; if (confirmationDialog) dialog = true; },
    };
    return { offsetParent: {}, innerText: text, getAttribute: () => null,
      matches: () => false, querySelector: () => control, control };
  });
  const document = {
    querySelectorAll(selector) {
      if (selector.startsWith('label')) return labels;
      if (selector.startsWith('[role="dialog"]')) return dialog ? [{ offsetParent: {}, innerText: '请阅读并确认声明' }] : [];
      return [];
    }, getElementById: () => null,
  };
  const page = { evaluate(source) { evaluations++; return vm.runInNewContext(source, { document }); } };
  return { page, labels, clicks: () => clicks, evaluations: () => evaluations };
}

test('declarations are opt-in and require explicit boolean values', async () => {
  assert.deepEqual(validateDeclarations({}), {});
  assert.deepEqual(validateDeclarations({ original: 'true', 'ai-declaration': false }), { original: true, aiGenerated: false });
  assert.throws(() => validateDeclarations({ original: '转载' }), /true or false/);
  const f = fixture();
  const actual = await applyDeclarations(f.page);
  assert.equal(actual.confirmed, true);
  assert.equal(f.evaluations(), 0);
  assert.equal(actual.capabilities.original, 'unknown');
});

test('an exact original declaration checkbox is clicked once and reread', async () => {
  const f = fixture([{ text: '原创声明' }]);
  const actual = await applyDeclarations(f.page, { original: true });
  assert.equal(f.clicks(), 1);
  assert.equal(actual.observed.original, true);
  assert.match(actual.verification, /composer-controls-only/);
  await applyDeclarations(f.page, { original: true });
  assert.equal(f.clicks(), 1);
});

test('repost language and ambiguous original controls never become original claims', async () => {
  const repost = fixture([{ text: '来源转载' }]);
  await assert.rejects(applyDeclarations(repost.page, { original: true }), /unsupported/);
  assert.equal(repost.clicks(), 0);
  const ambiguous = fixture([{ text: '原创声明' }, { text: '声明原创' }]);
  await assert.rejects(applyDeclarations(ambiguous.page, { original: true }), /ambiguous/);
  assert.equal(ambiguous.clicks(), 0);
});

test('AI declaration false is applied only when explicitly requested', async () => {
  const f = fixture([{ text: '内容由 AI 生成', checked: true }]);
  const actual = await applyDeclarations(f.page, { aiGenerated: false });
  assert.equal(actual.observed.aiGenerated, false);
  assert.equal(f.clicks(), 1);
});

test('disabled controls and new confirmation dialogs stop before submission', async () => {
  const disabled = fixture([{ text: '原创声明', disabled: true }]);
  await assert.rejects(applyDeclarations(disabled.page, { original: true }), /disabled/);
  assert.equal(disabled.clicks(), 0);
  const confirmation = fixture([{ text: '原创声明' }], { confirmationDialog: true });
  await assert.rejects(applyDeclarations(confirmation.page, { original: true }), /Could not confirm/);
  assert.equal(confirmation.clicks(), 1);
});

test('readDeclarations reports available values and leaves the composer unchanged', async () => {
  const f = fixture([{ text: '原创声明', checked: true }, { text: '内容由AI生成', checked: false }]);
  const actual = await readDeclarations(f.page);
  assert.deepEqual(actual.values, { original: true, aiGenerated: false });
  assert.equal(actual.capabilities.original, 'supported');
  assert.equal(actual.verification, 'saved-composer-controls');
  assert.equal(f.clicks(), 0);
});

test('readDeclarations reports unavailable controls without throwing', async () => {
  const f = fixture();
  const actual = await readDeclarations(f.page);
  assert.deepEqual(actual.values, {});
  assert.equal(actual.capabilities.original, 'unavailable');
  assert.equal(actual.capabilities.aiGenerated, 'unavailable');
  assert.equal(f.clicks(), 0);
});
