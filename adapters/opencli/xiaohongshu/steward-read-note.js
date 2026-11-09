import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { validateNoteId, openEditor, readEditor } from './editor-helpers.mjs';

export async function readNote(page, noteId) {
  await openEditor(page, validateNoteId(noteId));
  const row = await readEditor(page);
  if (!row) throw new CommandExecutionError('The editor fields could not be read');
  return {
    noteId,
    ...row,
    mediaType: row.mediaType,
    verification: {
      title: true, body: true, nativeTopics: true, imageCount: true,
      imageOrder: 'urls-only', videoBytes: false, coverIdentity: false,
    },
  };
}

cli({
  site: 'xiaohongshu', name: 'steward-read-note',
  description: 'Read saved title, body, native topic nodes and media from the creator editor',
  access: 'read', domain: 'creator.xiaohongshu.com', strategy: Strategy.COOKIE,
  browser: true, navigateBefore: false,
  args: [{ name: 'note-id', required: true, positional: true, help: '24-character note ID' }],
  columns: ['noteId', 'title', 'body', 'topics', 'imageCount', 'images', 'mediaType', 'videoPresent', 'video', 'cover', 'verification', 'url'],
  func: async (page, kwargs) => [await readNote(page, String(kwargs['note-id'] ?? ''))],
});
