/**
 * Xiaohongshu creator-note inventory.
 *
 * Read-only UI adapter: opens the creator note manager, scrolls the virtual
 * list until the requested number of unique note cards is loaded, and returns
 * stable IDs with visible metadata. It does not open or modify any note.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { withOwnedTabCleanup } from './owned-tab.mjs';

const MANAGER_URL = 'https://creator.xiaohongshu.com/new/note-manager';

function extractCardsScript() {
  return `(() => {
    const cards = Array.from(document.querySelectorAll('.note-card'));
    return cards.map((card) => {
      let impression = {};
      try {
        impression = JSON.parse(card.getAttribute('data-impression') || '{}');
      } catch {
        impression = {};
      }
      const text = card.innerText || '';
      const statusEl = Array.from(card.querySelectorAll('[class*="status"], [class*="audit"]'))
        .find((element) => (element.innerText || '').trim());
      let status = (statusEl?.innerText || '').trim();
      if (!status) {
        if (text.includes('审核中')) status = '审核中';
        else if (text.includes('未通过')) status = '未通过';
        else status = 'unknown';
      }
      return {
        id: String(impression?.noteTarget?.value?.noteId || ''),
        title: String(card.querySelector('.note-card__title')?.textContent || '').trim(),
        date: String(card.querySelector('.note-card__time')?.textContent || '').trim(),
        cover: String(card.querySelector('.note-card__cover img')?.getAttribute('src') || ''),
        status,
      };
    }).filter((card) => card.id);
  })()`;
}

function scrollManagerScript() {
  return `(() => {
    const scroller = Array.from(document.querySelectorAll('*'))
      .find((element) =>
        element.scrollHeight > element.clientHeight + 20 &&
        ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
      );
    if (!scroller) return { found: false, atBottom: true, count: 0 };
    const before = Number(scroller.scrollTop);
    scroller.scrollTop = scroller.scrollHeight;
    return {
      found: true,
      atBottom: before + scroller.clientHeight >= scroller.scrollHeight - 4,
      count: document.querySelectorAll('.note-card').length,
      scrollHeight: Number(scroller.scrollHeight),
      scrollTop: Number(scroller.scrollTop),
    };
  })()`;
}

function inventoryTotalScript() {
  return `(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/(?:^|\\n)全部\\s+(\\d+)(?:\\s|$)/);
    if (!match) return null;
    const total = Number(match[1]);
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
  })()`;
}

cli({
  site: 'xiaohongshu',
  name: 'inventory',
  description: '只读加载小红书创作者笔记清单，供分批巡检与自动优化使用',
  access: 'read',
  example: 'opencli xiaohongshu inventory --limit 50 -f json',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'limit', type: 'int', default: 50, help: 'Maximum unique notes to return (1-1000)' },
    { name: 'include-meta', type: 'bool', default: false, help: 'Return total, complete and truncated coverage metadata' },
  ],
  columns: ['rank', 'id', 'title', 'date', 'status', 'cover'],
  func: withOwnedTabCleanup(async (page, kwargs) => {
    const limit = Number(kwargs.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ArgumentError('limit must be an integer between 1 and 1000');
    }

    await page.goto(MANAGER_URL);
    await page.wait({ time: 2 });
    const currentUrl = String(await page.evaluate('location.href'));
    if (/login|passport/i.test(currentUrl)) throw new AuthRequiredError('creator.xiaohongshu.com');
    const advertisedTotal = await page.evaluate(inventoryTotalScript());
    const total = Number.isSafeInteger(advertisedTotal) && advertisedTotal >= 0
      ? advertisedTotal
      : null;

    const notes = new Map();
    let stagnantRounds = 0;
    let exhausted = false;
    for (let round = 0; round < 160 && notes.size < limit; round += 1) {
      const batch = await page.evaluate(extractCardsScript());
      if (!Array.isArray(batch)) {
        throw new CommandExecutionError('Creator note manager returned an unexpected card list');
      }
      const previousSize = notes.size;
      for (const note of batch) {
        if (!notes.has(note.id)) notes.set(note.id, note);
        if (notes.size >= limit) break;
      }

      if (notes.size > previousSize) stagnantRounds = 0;
      else stagnantRounds += 1;
      if (stagnantRounds >= 4) {
        exhausted = true;
        break;
      }
      if (total != null && notes.size >= total) break;

      const scroll = await page.evaluate(scrollManagerScript());
      if (!scroll?.found) {
        // Small and empty accounts do not need a scroll container.
        exhausted = true;
        break;
      }
      await page.wait({ time: 1.1 });
    }

    if (notes.size === 0) {
      const empty = await page.evaluate(`(() => {
        const elements = Array.from(document.querySelectorAll('[class*="empty"]'));
        return elements.some(element => element.offsetParent !== null &&
          /暂无笔记|还没有.*笔记|没有发布.*笔记/.test(element.innerText || ''));
      })()`);
      if (empty) return [];
      throw new CommandExecutionError(
        'No creator note cards loaded',
        'Confirm the account is logged in and the note manager is available.',
      );
    }
    const result = Array.from(notes.values()).slice(0, limit).map((note, index) => ({
      rank: index + 1,
      ...note,
    }));
    if (!kwargs['include-meta']) return result;
    const complete = total != null
      ? result.length >= total
      : exhausted && result.length < limit;
    return {
      notes: result,
      total,
      returned: result.length,
      complete,
      truncated: total != null ? result.length < total : !complete,
      requestedLimit: limit,
    };
  }),
});
