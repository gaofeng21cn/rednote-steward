import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReviewWorkspace, safeSegment } from '../src/lib/workspace.mjs';

test('sanitizes a title for a directory segment', () => {
  assert.equal(safeSegment('标题/带:符号'), '标题_带_符号');
});

test('creates a review workspace without a publish manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-ops-review-'));
  const directory = await createReviewWorkspace({
    root,
    existingNoteId: '000000000000000000000001',
    row: {
      title: '标题',
      publishedAt: '2026-10-20',
      views: 100,
      collects: 1,
      comments: 2,
      duration: 30,
      topSource: '首页推荐',
      flags: ['discussion'],
    },
  });
  const review = JSON.parse(await fs.readFile(path.join(directory, 'review.json'), 'utf8'));
  assert.equal(review.status, 'awaiting-human-edit');
  assert.equal(review.sourceNoteId, '000000000000000000000001');
  await assert.rejects(() => fs.stat(path.join(directory, 'post.json')));
});

test('review imports cannot escape the selected directory or replace an existing review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-review-'));
  try {
    await assert.rejects(() => createReviewWorkspace({ root, existingNoteId: '../../outside', row: { title:'Example' } }), /valid platform note ID/);
    const input = { root, existingNoteId:'000000000000000000000001', row:{title:'Example'} };
    const dir = await createReviewWorkspace(input);
    await fs.writeFile(path.join(dir,'review.json'),'User working notes');
    await createReviewWorkspace(input);
    assert.equal(await fs.readFile(path.join(dir,'review.json'),'utf8'),'User working notes');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
