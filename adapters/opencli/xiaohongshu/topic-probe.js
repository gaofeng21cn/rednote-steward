/**
 * Read-only Xiaohongshu topic candidate probe.
 *
 * Opens an existing note editor, searches the platform's native topic picker,
 * and returns visible labels. Search input is temporary; it never selects a
 * topic or saves the editor.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  TimeoutError,
} from '@jackwener/opencli/errors';

const EDIT_PATH = '/publish/update';
const BODY_SELECTOR = '.tiptap.ProseMirror';

function normalize(value) {
  return String(value ?? '').replace(/^#/, '').replace(/\s+/g, '').trim();
}

async function waitFor(page, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.wait({ time: 0.4 });
  }
  throw new TimeoutError(label, Math.ceil(timeoutMs / 1000));
}

async function openEditor(page, noteId) {
  await page.goto(
    `https://creator.xiaohongshu.com${EDIT_PATH}?id=${encodeURIComponent(noteId)}&noteType=normal`,
  );
  await waitFor(
    page,
    async () => Boolean(await page.evaluate(
      `(selector => Boolean(Array.from(document.querySelectorAll(selector))
        .find((element) => element.offsetParent !== null)))(${JSON.stringify(BODY_SELECTOR)})`,
    )),
    15_000,
    'Xiaohongshu note editor',
  );
  const url = String(await page.evaluate('location.href'));
  if (/login|passport/i.test(url)) throw new AuthRequiredError('creator.xiaohongshu.com');
  if (!url.includes(noteId)) {
    throw new CommandExecutionError(`Editor did not open note ${noteId}`);
  }
}

async function focusBodyEnd(page) {
  const focused = await page.evaluate(
    `(selector => {
      const editor = Array.from(document.querySelectorAll(selector))
        .find((element) => element.offsetParent !== null);
      if (!editor) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    })(${JSON.stringify(BODY_SELECTOR)})`,
  );
  if (!focused) throw new CommandExecutionError('Could not focus the note body');
}

async function openTopicPicker(page) {
  const clicked = await page.evaluate(
    `(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((element) => (element.innerText || '').includes('话题'));
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new CommandExecutionError('Could not open the topic picker');
  await page.wait({ time: 0.3 });
}

async function readSuggestions(page) {
  return page.evaluate(
    `(() => {
      const container = document.querySelector('#creator-editor-topic-container');
      if (!container) return { found: false, labels: [] };
      const labels = Array.from(container.querySelectorAll('.item'))
        .map((item) => (item.querySelector('.name')?.textContent || item.textContent || '').trim())
        .filter(Boolean);
      return { found: true, labels };
    })()`,
  );
}

cli({
  site: 'xiaohongshu',
  name: 'topic-probe',
  description: '只读探测已发布笔记编辑器中的真实话题候选，不选择、不保存、不提交',
  access: 'read',
  example:
    'opencli xiaohongshu topic-probe 0123456789abcdef01234567 --topics "南航,飞机餐" -f json',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'note-id', required: true, positional: true, help: '24-character note ID' },
    { name: 'topics', required: true, help: 'Comma-separated topic search terms' },
  ],
  columns: ['query', 'exact', 'labels'],
  func: async (page, kwargs) => {
    const noteId = String(kwargs['note-id'] ?? '').trim();
    if (!/^[a-f0-9]{24}$/i.test(noteId)) {
      throw new ArgumentError('note-id must be the 24-character Xiaohongshu note ID');
    }
    const queries = String(kwargs.topics ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (queries.length === 0) throw new ArgumentError('topics is required');

    await openEditor(page, noteId);
    const results = [];
    for (const query of queries) {
      await focusBodyEnd(page);
      // Each search needs a fresh paragraph, especially after an emoji or a
      // previous dismissed hashtag query. Nothing is saved by this probe.
      await page.pressKey('Enter');
      await openTopicPicker(page);
      if (typeof page.insertText !== 'function') {
        throw new CommandExecutionError('Native text insertion is unavailable');
      }
      await page.insertText(query);
      // The picker first shows recommendations; wait for its search debounce
      // before treating the first nonempty list as the requested candidates.
      await page.wait({ time: 1 });
      let suggestions = { found: false, labels: [] };
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        suggestions = await readSuggestions(page);
        if (suggestions.found && suggestions.labels.length > 0) break;
        await page.wait({ time: 0.4 });
      }
      results.push({
        query,
        exact: suggestions.labels.find((label) => normalize(label) === normalize(query)) || '',
        labels: suggestions.labels.join(' | '),
      });
      await page.pressKey('Escape');
      await page.wait({ time: 0.3 });
    }
    return results;
  },
});
