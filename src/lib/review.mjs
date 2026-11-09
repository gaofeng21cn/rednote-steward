import { createHash } from 'node:crypto';

// The revision follows the owner's stored task, including observed outcomes.
// A content fingerprint alone does not identify a queued/running/read-back revision.
export function reviewRevision(task) {
  return `sha256:${createHash('sha256').update(JSON.stringify(task)).digest('hex')}`;
}

export function reviewItem(task, events, source) {
  const revision = reviewRevision(task);
  const expected = { title: task.title, body: task.body, topics: task.topics,
    images: task.images, video: task.video, cover: task.cover, subtitle: task.subtitle,
    declarations: task.declarations ?? null, mediaLineage: task.media_lineage ?? task.mediaLineage ?? [],
    seriesId: task.series_id ?? task.seriesId ?? null, episode: task.episode ?? null,
    contentType: task.content_type ?? task.contentType ?? null, batchId: task.batch_id ?? task.batchId ?? null };
  const assets = [...task.images.map(asset => ({ ...asset, kind: 'image' })),
    ...['video', 'cover', 'subtitle'].flatMap(kind => task[kind] ? [{ ...task[kind], kind }] : [])];
  const unresolved = ['running', 'submitted', 'needs_review'].includes(task.state);
  return {
    id: task.id, task_id: task.id, title: task.title, status: task.state,
    phase: task.phase ?? null, phase_at: task.phase_at ?? null, attempt_id: task.attempt_id ?? null,
    last_error_code: task.last_error_code ?? null,
    worker_launch: task.worker_launch ?? null,
    last_error_detail: task.last_error_detail ?? null,
    revision, fingerprint: task.fingerprint, owner: 'rednote-steward',
    summary: `${task.account} · ${task.kind} · ${task.state}`,
    target: { account: task.account, account_user_id: task.account_user_id,
      source_note_id: task.source_note_id, platform_note_id: task.platform_note_id },
    source_state: source,
    preview: { target: { task_id: task.id, fingerprint: task.fingerprint, revision },
      ...(task.baseline_note ? { before: task.baseline_note } : {}), after: expected },
    artifacts: assets.map(asset => ({ id: `${task.id}:${asset.kind}:${asset.order ?? 1}`,
      title: `${asset.kind}: ${asset.name}`, artifact_kind: asset.kind,
      artifact_ref: asset.path, revision: `sha256:${asset.sha256}`, bytes: asset.bytes,
      availability: source.state === 'current' ? 'available' : 'unavailable',
      source_refs: [task.manifest_path] })),
    readback: task.readback, verification: task.verification,
    publication_evidence: { submission: task.platform_note_id ? 'located' : task.write_started_at ? 'outcome_unknown' : 'not_started',
      fields: task.verification?.matched === true ? 'matched' : task.verification ? 'needs_review' : 'not_read',
      public_visibility: 'not_evaluated', moderation: 'not_evaluated' },
    events: events.map(event => ({ title: event.event, occurred_at: event.created_at,
      ...(event.payload?.error ? { summary: event.payload.error } : {}),
      ...(event.payload?.receipt ? { source_refs: [event.payload.receipt] } : {}) })),
    last_error: task.last_error,
    next_action: { title: unresolved ? 'Read or reconcile the original task' : source.state !== 'current' ? 'Inspect and ingest the current package' : 'Continue through the existing task owner',
      summary: unresolved ? `xhs-ops show ${task.id}; xhs-ops reconcile ${task.id}` : `xhs-ops review ${task.id}` },
    source_refs: [`rednote://tasks/${task.id}`, task.manifest_path],
  };
}
