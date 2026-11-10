import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { validateNoteId, openEditor, readEditor, waitFor } from './editor-helpers.mjs';
import { readDeclarations } from './declarations.mjs';
import { withOwnedTabCleanup } from './owned-tab.mjs';

export async function readCoverHash(page, url) {
  return page.evaluate(`(async () => {
    const target = new URL(${JSON.stringify(url)});
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        !['xhscdn.com', 'xhsimg.com', 'xiaohongshu.com'].some(host => target.hostname === host || target.hostname.endsWith('.' + host))) throw new Error('cover URL is outside the platform media hosts');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(target, { redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('cover download failed');
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 20 * 1024 * 1024) throw new Error('cover size is outside bounds');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      if (!length) throw new Error('cover size is outside bounds');
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength };
    } finally { clearTimeout(timer); }
  })()`);
}

export async function readNote(page, noteId, noteType = 'normal', { coverHash = false } = {}) {
  if (!['normal', 'video'].includes(noteType)) throw new CommandExecutionError('note-type must be normal or video');
  await openEditor(page, validateNoteId(noteId), noteType);
  let row = await readEditor(page);
  if (!row) throw new CommandExecutionError('The editor fields could not be read');
  if (noteType === 'video' || row.videoPresent) {
    await waitFor(page, async () => {
      row = await readEditor(page);
      return row?.videoPresent && Boolean(row.video?.src);
    }, 15_000, 500, 'saved video source');
  }
  const evidence = coverHash && row.cover?.url ? await readCoverHash(page, row.cover.url) : null;
  if (evidence) {
    const after = await readEditor(page);
    if (after?.cover?.url !== row.cover.url) throw new CommandExecutionError('Cover changed during content readback');
    row = after;
  }
  return {
    noteId,
    ...row,
    declarations: await readDeclarations(page),
    mediaType: row.mediaType,
    verification: {
      title: true, body: true, nativeTopics: true, imageCount: true,
      imageOrder: 'urls-only', videoBytes: false, coverIdentity: false,
    },
    ...(evidence ? { coverContent: evidence } : {}),
  };
}

cli({
  site: 'xiaohongshu', name: 'steward-read-note',
  description: 'Read saved title, body, native topic nodes and media from the creator editor',
  access: 'read', domain: 'creator.xiaohongshu.com', strategy: Strategy.COOKIE,
  browser: true, navigateBefore: false,
  args: [
    { name: 'note-id', required: true, positional: true, help: '24-character note ID' },
    { name: 'note-type', default: 'normal', help: 'normal or video editor' },
    { name: 'cover-hash', type: 'bool', default: false, help: 'Read the current cover bytes in the bound browser context' },
  ],
  columns: ['noteId', 'title', 'body', 'topics', 'imageCount', 'images', 'mediaType', 'videoPresent', 'video', 'cover', 'declarations', 'verification', 'url'],
  func: withOwnedTabCleanup(async (page, kwargs) => [
    await readNote(page, String(kwargs['note-id'] ?? ''), kwargs['note-type'] || 'normal', { coverHash: kwargs['cover-hash'] === true }),
  ]),
});
