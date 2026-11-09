import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRows, parseDuration, parseMetricNumber, reviewCandidates } from '../src/lib/audit.mjs';

test('parses Chinese display metrics', () => {
  assert.equal(parseMetricNumber('1.2万'), 12000);
  assert.equal(parseMetricNumber('-'), null);
  assert.equal(parseDuration('31.9秒'), 31.9);
  assert.equal(parseDuration('-'), null);
});

test('surfaces review signals without turning them into edit instructions', () => {
  const rows = auditRows([
    {
      id: 'a',
      title: '高观看短停留',
      views: '1000',
      collects: '1',
      comments: '2',
      avg_view_time: '8秒',
    },
    {
      id: 'b',
      title: '深度长停留',
      views: '1000',
      collects: '1',
      comments: '1',
      avg_view_time: '30秒',
    },
    {
      id: 'c',
      title: '讨论',
      views: '100',
      collects: '1',
      comments: '10',
      avg_view_time: '12秒',
    },
  ]);
  const candidates = reviewCandidates(rows);
  assert.equal(candidates[0].id, 'c');
  assert.deepEqual(candidates.find((row) => row.id === 'a').flags, [
    'high_views_short_dwell',
    'low_save_ratio',
  ]);
  assert.deepEqual(candidates.find((row) => row.id === 'b').flags, ['low_save_ratio']);
});
