import { cli, Strategy } from '@jackwener/opencli/registry';
import { readEditor } from './editor-helpers.mjs';

cli({
  site: 'xiaohongshu',
  name: 'steward-read-composer',
  description: 'Read the current unsaved creator composer without changing or submitting it',
  access: 'read',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['url', 'title', 'body', 'topics', 'mediaType', 'videoPresent', 'imageCount'],
  func: async page => {
    const row = await readEditor(page);
    if (!row) throw new Error('No active creator composer could be read');
    return [row];
  },
});
