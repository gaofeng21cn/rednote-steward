// RedNote Steward. Derived from the account-ops local OpenCLI adapter.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { applyCover } from './cover-editor.mjs';
import { applyDeclarations, validateDeclarations } from './declarations.mjs';
import { emitProgress } from '../../../src/lib/progress.mjs';
import { videoSourceChanged } from '../../../src/lib/media.mjs';
import { validateNoteId, validateTitle, validateBody, validateTopics, validateImages, validateVideo, openEditor, readEditor, fillTitle, fillBody, replaceTopics, replaceImages, replaceVideo, normalizeForComparison, sameTopics, submitEdit, editUrl, waitFor } from './editor-helpers.mjs';
import { withOwnedTabCleanup } from './owned-tab.mjs';

cli({
  site: 'xiaohongshu',
  name: 'edit-note',
  description: '批量编辑已发布小红书笔记（文案、真实话题、图片或视频），并回读验收',
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
    { name: 'video', default: '', help: 'Replacement video file; empty keeps existing video' },
    { name: 'cover', default: '', help: 'Custom cover for the replacement video' },
    { name: 'original', help: 'Explicit original declaration: true or false; omitted leaves the current setting' },
    { name: 'ai-declaration', help: 'Explicit AI-generated declaration: true or false; omitted leaves the current setting' },
    { name: 'prepare-only', type: 'bool', default: false, help: 'Prepare the edit without invoking submission' },
    { name: 'upload-timeout', type: 'int', default: 600, help: 'Video upload/processing timeout in seconds' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Open and read the note without changing or submitting it' },
  ],
  columns: ['status', 'noteId', 'title', 'body', 'topicNodes', 'topics', 'images', 'mediaType', 'videoPresent', 'video', 'cover', 'replacement', 'declarations', 'readback', 'submitted', 'snapshot', 'recovery'],
  func: withOwnedTabCleanup(async (page, kwargs) => {
    const noteId = validateNoteId(kwargs['note-id']);
    const title = kwargs['dry-run'] ? String(kwargs.title ?? '').trim() : validateTitle(kwargs.title);
    const content = kwargs['dry-run'] ? String(kwargs.content ?? '').trim() : validateBody(kwargs.content);
    const topics = validateTopics(kwargs.topics);
    const images = validateImages(kwargs.images);
    const video = validateVideo(kwargs.video);
    const cover = kwargs.cover ? validateImages(kwargs.cover) : [];
    const desiredDeclarations = validateDeclarations(kwargs);
    const prepareOnly = kwargs['prepare-only'] === true || kwargs['prepare-only'] === 'true';
    if (cover.length > 1 || (cover.length && !video)) throw new CommandExecutionError('A custom cover requires exactly one replacement video');
    if (video && images.length) throw new CommandExecutionError('Choose replacement video or images, not both');
    const timeoutSeconds = Number(kwargs['upload-timeout'] ?? 600);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
      throw new CommandExecutionError('upload-timeout must be between 10 and 3600 seconds');
    }

    await openEditor(page, noteId, video ? 'video' : 'normal');
    emitProgress('selected', { kind: 'edit', noteId });
    const before = await readEditor(page);
    if (!before) throw new CommandExecutionError('The note editor loaded but its fields could not be read');
    if (video && before.mediaType !== 'video') {
      throw new CommandExecutionError('Video replacement requires an existing video note');
    }

    if (kwargs['dry-run']) {
      return [{
        status: 'dry-run',
        noteId,
        title: before.title,
        body: before.body,
        topicNodes: before.topics,
        topics: before.topics.map((topic) => topic.name).join(', '),
        images: String(before.imageCount),
        mediaType: before.mediaType, videoPresent: before.videoPresent,
        video: before.video, cover: before.cover,
        readback: 'unchanged',
      }];
    }

    const replacement = video ? await replaceVideo(page, video, timeoutSeconds * 1000) : null;
    const coverSelection = cover.length ? await applyCover(page, cover[0]) : null;
    await fillTitle(page, title);
    await fillBody(page, content);
    await replaceTopics(page, topics);
    await replaceImages(page, images);
    const declarations = await applyDeclarations(page, desiredDeclarations);

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
    if (video && (!prepared.videoPresent || !(prepared.video?.duration > 0))) {
      throw new CommandExecutionError('Pre-submit video is absent or not ready');
    }
    emitProgress('prepared', { kind: 'edit', noteId, mediaType: prepared.mediaType,
      nativeTopicCount: prepared.topics.length, declarations: declarations.observed,
      composer: { url: prepared.url, observedAt: new Date().toISOString(), persistence: 'not-confirmed' } });
    if (prepareOnly) return [{ status: 'prepared', submitted: false, noteId, title: prepared.title,
      body: prepared.body, topics: prepared.topics, mediaType: prepared.mediaType,
      replacement, cover: coverSelection, declarations, snapshot: prepared,
      recovery: { composerObserved: true, persistedDraftVerified: false,
        instruction: 'Inspect this same composer and account before continuing; no submission was invoked.' } }];
    emitProgress('submit_attempted', { kind: 'edit', noteId });
    const submitMethod = await submitEdit(page);
    emitProgress('platform_accepted', { kind: 'edit', noteId, confirmation: 'creator-edit-success-page' });
    emitProgress('readback', { noteId });
    await openEditor(page, noteId, video ? 'video' : 'normal');
    let after = await readEditor(page);
    if (!after) throw new CommandExecutionError('The note editor could not be reopened for readback');
    if (video) await waitFor(page, async () => {
      after = await readEditor(page);
      return after?.videoPresent && after.video?.duration > 0;
    }, 15_000, 500, 'saved video metadata');

    const verified =
      after.title === title &&
      normalizeForComparison(after.body) === normalizeForComparison(content) &&
      sameTopics(after.topics, topics) &&
      (!images.length || after.imageCount === images.length) &&
      (!video || (after.videoPresent && after.video?.duration > 0));
    if (!verified) {
      throw new CommandExecutionError(
        `Saved note ${noteId}, but readback did not match the requested title/body/topics/media`,
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
      mediaType: after.mediaType, videoPresent: after.videoPresent, video: after.video,
      cover: coverSelection,
      declarations,
      replacement: replacement ? { ...replacement, after: after.video,
        savedSourceChanged: videoSourceChanged(before.video?.src, after.video?.src), bytesCompared: false } : null,
      readback: video && !videoSourceChanged(before.video?.src, after.video?.src)
        ? 'saved fields match; replacement video version unconfirmed' : `verified observable fields via ${submitMethod}`,
    }];
  }),
});
