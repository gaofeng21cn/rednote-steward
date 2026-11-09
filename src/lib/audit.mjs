export function parseMetricNumber(value) {
  if (value == null || value === '' || value === '-') return null;
  const text = String(value).trim();
  const match = text.match(/^([\d.]+)\s*([万wW])?/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return match[2] ? number * 10_000 : number;
}

export function parseDuration(value) {
  if (value == null || value === '' || value === '-') return null;
  const text = String(value).trim();
  const match = text.match(/^([\d.]+)\s*(秒|s)?$/);
  return match ? Number(match[1]) : null;
}

export function auditRows(metrics) {
  return metrics.map((row) => {
    const views = parseMetricNumber(row.views);
    const collects = parseMetricNumber(row.collects);
    const comments = parseMetricNumber(row.comments);
    const duration = parseDuration(row.avg_view_time);
    const flags = [];
    if (views != null && views >= 300 && duration != null && duration < 10) {
      flags.push('high_views_short_dwell');
    }
    if (views != null && views >= 300 && collects != null && views > 0 &&
        collects / views < 0.005) {
      flags.push('low_save_ratio');
    }
    if (comments != null && comments >= 5) flags.push('discussion');
    if (views == null) flags.push('metrics_unavailable');
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      publishedAt: String(row.published_at ?? ''),
      views,
      collects,
      comments,
      duration,
      topSource: String(row.top_source ?? ''),
      flags,
      reviewPriority: flags.includes('discussion') ? 2
        : flags.includes('high_views_short_dwell') || flags.includes('low_save_ratio') ? 1
          : 0,
    };
  });
}

export function reviewCandidates(rows) {
  return rows
    .filter((row) => row.reviewPriority > 0)
    .sort((left, right) => right.reviewPriority - left.reviewPriority ||
      (right.views ?? 0) - (left.views ?? 0));
}
