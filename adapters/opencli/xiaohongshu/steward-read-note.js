import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { validateNoteId, openEditor, readEditor, waitFor } from './editor-helpers.mjs';
import { readDeclarations } from './declarations.mjs';
import { withOwnedTabCleanup } from './owned-tab.mjs';

export async function readNote(page, noteId, noteType = 'normal') {
  if (!['normal', 'video'].includes(noteType)) throw new CommandExecutionError('note-type must be normal or video');
  await openEditor(page, validateNoteId(noteId), noteType);
  let row = await readEditor(page);
  if (!row) throw new CommandExecutionError('The editor fields could not be read');
  if (noteType === 'video' || row.videoPresent) {
    await waitFor(page, async () => {
      row = await readEditor(page);
      return row?.videoPresent && row.video?.duration > 0;
    }, 15_000, 500, 'saved video metadata');
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
  ],
  columns: ['noteId', 'title', 'body', 'topics', 'imageCount', 'images', 'mediaType', 'videoPresent', 'video', 'cover', 'declarations', 'verification', 'url'],
  func: withOwnedTabCleanup(async (page, kwargs) => [
    await readNote(page, String(kwargs['note-id'] ?? ''), kwargs['note-type'] || 'normal'),
  ]),
});
