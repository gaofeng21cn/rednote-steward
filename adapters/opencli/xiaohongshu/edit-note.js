// RedNote Steward. Derived from the account-ops local OpenCLI adapter.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { validateNoteId, validateTitle, validateBody, validateTopics, validateImages, openEditor, readEditor, fillTitle, fillBody, replaceTopics, replaceImages, normalizeForComparison, sameTopics, submitEdit, editUrl } from './editor-helpers.mjs';

cli({
  site: 'xiaohongshu',
  name: 'edit-note',
  description: '批量编辑已发布小红书笔记（文案、真实话题、图片），并回读验收',
  access: 'write',
  example:
    'opencli xiaohongshu edit-note 0123456789abcdef01234567 --title "标题" --content "正文" --topics "旅行,城市漫步"',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'note-id', required: true, positional: true, help: '24-character note ID' },
    { name: 'title', default: '', help: 'Replacement title (max 20 characters; required unless --dry-run)' },
    { name: 'content', default: '', help: 'Replacement body without hashtags (required unless --dry-run)' },
    { name: 'topics', default: '', help: 'Comma-separated exact Xiaohongshu topics; empty removes topics when replacing the body' },
    { name: 'images', default: '', help: 'Comma-separated complete image list in display order; empty keeps existing images' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Open and read the note without changing or submitting it' },
  ],
  columns: ['status', 'noteId', 'title', 'body', 'topicNodes', 'topics', 'images', 'readback'],
  func: async (page, kwargs) => {
    const noteId = validateNoteId(kwargs['note-id']);
    const title = kwargs['dry-run'] ? String(kwargs.title ?? '').trim() : validateTitle(kwargs.title);
    const content = kwargs['dry-run'] ? String(kwargs.content ?? '').trim() : validateBody(kwargs.content);
    const topics = validateTopics(kwargs.topics);
    const images = validateImages(kwargs.images);

    await openEditor(page, noteId);
    const before = await readEditor(page);
    if (!before) throw new CommandExecutionError('The note editor loaded but its fields could not be read');

    if (kwargs['dry-run']) {
      return [{
        status: 'dry-run',
        noteId,
        title: before.title,
        body: before.body,
        topicNodes: before.topics,
        topics: before.topics.map((topic) => topic.name).join(', '),
        images: String(before.imageCount),
        readback: 'unchanged',
      }];
    }

    await fillTitle(page, title);
    await fillBody(page, content);
    await replaceTopics(page, topics);
    await replaceImages(page, images);

    const prepared = await readEditor(page);
    if (!prepared) throw new CommandExecutionError('Could not verify the edited fields before submission');
    if (prepared.title !== title) {
      throw new CommandExecutionError(`Pre-submit title mismatch: ${JSON.stringify(prepared.title)}`);
    }
    if (normalizeForComparison(prepared.body) !== normalizeForComparison(content)) {
      throw new CommandExecutionError('Pre-submit body mismatch');
    }
    if (!sameTopics(prepared.topics, topics)) {
      throw new CommandExecutionError(
        `Pre-submit topic mismatch: expected ${topics.join(', ')}, got ${prepared.topics.map((topic) => topic.name).join(', ')}`,
      );
    }
    if (images.length && prepared.imageCount !== images.length) {
      throw new CommandExecutionError(
        `Pre-submit image mismatch: expected ${images.length}, got ${prepared.imageCount}`,
      );
    }

    const submitMethod = await submitEdit(page);
    await openEditor(page, noteId);
    const after = await readEditor(page);
    if (!after) throw new CommandExecutionError('The note editor could not be reopened for readback');

    const verified =
      after.title === title &&
      normalizeForComparison(after.body) === normalizeForComparison(content) &&
      sameTopics(after.topics, topics) &&
      (!images.length || after.imageCount === images.length);
    if (!verified) {
      throw new CommandExecutionError(
        `Saved note ${noteId}, but readback did not match the requested title/body/topics/images`,
        `Open ${editUrl(noteId)} and inspect the saved fields.`,
      );
    }

    return [{
      status: 'updated',
      noteId,
      title: after.title,
      body: after.body,
      topicNodes: after.topics,
      topics: after.topics.map((topic) => topic.name).join(', '),
      images: String(after.imageCount),
      readback: `verified via ${submitMethod}`,
    }];
  },
});
