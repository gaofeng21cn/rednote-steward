import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeSegment(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 48) || 'untitled';
}

export async function createReviewWorkspace({ root, row, existingNoteId }) {
  if (!/^[a-f0-9]{24}$/i.test(existingNoteId ?? '')) throw new Error('A valid platform note ID is required for a review workspace');
  const directory = path.join(
    root,
    `${existingNoteId}-${safeSegment(row.title)}`,
  );
  await fs.mkdir(path.join(directory, 'images'), { recursive: true });
  await fs.mkdir(path.join(directory, 'original'), { recursive: true });

  const review = {
    schemaVersion: 1,
    status: 'awaiting-human-edit',
    sourceNoteId: existingNoteId,
    originalTitle: row.title,
    publishedAt: row.publishedAt,
    metrics: {
      views: row.views,
      collects: row.collects,
      comments: row.comments,
      duration: row.duration,
      topSource: row.topSource,
    },
    reviewFlags: row.flags,
    note: '这是巡检线索，不是改稿结论。先回读原正文和图片，再决定是否编辑。',
  };
  await fs.writeFile(
    path.join(directory, 'review.json'),
    `${JSON.stringify(review, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  ).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return directory;
}
