import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { reviewItem, reviewRevision } from './review.mjs';
import { stateRoot, privateDirectory, getAccount, listAccounts } from './config.mjs';
import { openDatabase, transaction, addEvent, rowToTask, claimTask } from './db.mjs';
import { inspectPackage, verifyFrozenPackage, normalizeText } from './package.mjs';
import { publishArgs, editArgs, readInventory, readNote, readMetrics, runOpencli, verifiedIdentity, rowOf } from './opencli.mjs';
import { auditRows, reviewCandidates } from './audit.mjs';

const now = () => new Date().toISOString();
const serialize = value => value == null ? null : JSON.stringify(value);
function resultData(response, label) {
  if (response.exitCode !== 0 || response.json == null) throw new Error(response.stderr.trim() || `${label} returned no data`);
  return response.json;
}
function checkNoteId(id) {
  if (!/^[a-f0-9]{24}$/i.test(id ?? '')) throw new Error('A 24-character platform note ID is required');
  return id.toLowerCase();
}
function activeProcess(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function compareReadback(task, row, publication = null) {
  const expectedId = task.platform_note_id || task.source_note_id;
  const topics = Array.isArray(row?.topics) ? row.topics : [];
  const expectedTopics = [...task.topics].sort();
  const actualTopics = topics.map(topic => typeof topic === 'object' ? topic.name : topic).sort();
  const nativeTopics = topics.every(topic => typeof topic === 'object' && String(topic.id ?? '').length > 0);
  const checks = {
    noteId: Boolean(row?.noteId && (!expectedId || row.noteId === expectedId)),
    title: row?.verification?.title === true && row.title === task.title,
    body: row?.verification?.body === true && normalizeText(row.body) === normalizeText(task.body),
    topics: row?.verification?.nativeTopics === true && nativeTopics && JSON.stringify(actualTopics) === JSON.stringify(expectedTopics),
  };
  const baseline = task.baseline_note;
  if (task.video) {
    checks.media = row?.mediaType === 'video' && row?.videoPresent === true;
    if (task.cover) checks.customCover = Boolean(publication?.cover?.confirmationClicked && row?.cover?.url);
  } else if (task.images.length) {
    checks.media = row?.mediaType === 'image' && row?.verification?.imageCount === true && row.imageCount === task.images.length;
  } else if (baseline?.mediaType === 'video') {
    checks.media = row?.mediaType === 'video' && row.videoPresent === true;
  } else {
    checks.media = Boolean(baseline && row?.verification?.imageCount === true && row.imageCount === baseline.imageCount && row.mediaType === baseline.mediaType);
  }
  return {
    matched: Object.values(checks).every(Boolean), checks,
    scope: 'Observable title, body, native topics and media presence/count',
    limits: { mediaBytes: 'not-compared', imageOrder: 'platform-urls-only',
      customCover: task.cover ? (checks.customCover ? 'selection-confirmed-and-cover-present' : 'not-confirmed') : 'not-requested',
      publicVisibility: 'not-evaluated', moderation: 'not-evaluated' },
  };
}

export class Controller {
  constructor(root = stateRoot()) { this.root = root; this.dbPath = path.join(root, 'xhs-ops.sqlite'); }
  database() { return openDatabase(this.dbPath); }
  withDatabase(fn) { const db = this.database(); try { return fn(db); } finally { db.close(); } }
  init() {
    privateDirectory(this.root); privateDirectory(path.join(this.root, 'receipts'));
    this.withDatabase(() => {});
    return { ok: true, home: this.root, database: this.dbPath, accounts: listAccounts() };
  }
  show(id) {
    return this.withDatabase(db => {
      const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
      if (!task) throw new Error(`Task not found: ${id}`);
      const events = db.prepare('SELECT event, payload_json, created_at FROM events WHERE task_id = ? ORDER BY id').all(id)
        .map(({ payload_json, ...row }) => ({ ...row, payload: payload_json ? JSON.parse(payload_json) : null }));
      return { ok: true, task, events };
    });
  }
  plan({ account, all = false } = {}) {
    return this.withDatabase(db => {
      const where = [all ? '1 = 1' : "state IN ('draft','queued','running','submitted','needs_review','failed')"];
      const params = [];
      if (account) { where.push('account = ?'); params.push(account); }
      const tasks = db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at,created_at),created_at`).all(...params).map(rowToTask);
      return { ok: true, tasks };
    });
  }
  async review({ taskId, account, fingerprint, revision } = {}) {
    if (!taskId && (fingerprint || revision)) throw new Error('An exact task ID is required with a fingerprint or revision');
    if (!existsSync(this.dbPath)) {
      if (taskId) throw new Error(`Task not found: ${taskId}`);
      return { ok: true, items: [] };
    }
    // A preview neither initializes/migrates the database nor adds review state.
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    let snapshots;
    try {
      db.exec('BEGIN');
      const tasks = taskId ? [rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId))]
        : db.prepare(`SELECT * FROM tasks ${account ? 'WHERE account = ?' : ''} ORDER BY updated_at DESC`).all(...(account ? [account] : [])).map(rowToTask);
      if (taskId && !tasks[0]) throw new Error(`Task not found: ${taskId}`);
      snapshots = tasks.map(task => ({ task, events: db.prepare('SELECT event, payload_json, created_at FROM events WHERE task_id = ? ORDER BY id').all(task.id)
        .map(({ payload_json, ...event }) => ({ ...event, payload: payload_json ? JSON.parse(payload_json) : null })) }));
      db.exec('COMMIT');
    } finally { db.close(); }
    const items = [];
    for (const { task, events } of snapshots) {
      if (account && task.account !== account) throw new Error('Task does not belong to the selected account');
      if (fingerprint && task.fingerprint !== fingerprint) throw new Error('Task content fingerprint changed; reopen the exact task');
      if (revision && reviewRevision(task) !== revision) throw new Error('Task revision changed; reopen the exact task');
      let source = { state: 'current' };
      try { this.frozenAccount(task); await verifyFrozenPackage(task); }
      catch (error) { source = { state: 'stale', reason: error.message }; }
      items.push(reviewItem(task, events, source));
    }
    return { ok: true, items };
  }
  async ingest(input, { dryRun = false } = {}) {
    const content = await inspectPackage(input);
    if (dryRun) return { ok: true, dryRun: true, package: content };
    const account = getAccount(content.account);
    return this.withDatabase(db => transaction(db, () => {
      const duplicate = db.prepare(`SELECT id, state FROM tasks WHERE account_user_id = ? AND kind = ?
        AND fingerprint = ? AND COALESCE(source_note_id,'') = COALESCE(?,'')
        AND state NOT IN ('cancelled','failed') LIMIT 1`).get(account.userId, content.kind, content.fingerprint, content.sourceNoteId);
      if (duplicate) return { ok: true, duplicate: true, taskId: duplicate.id, state: duplicate.state };
      const id = `xhs_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const timestamp = now();
      db.prepare(`INSERT INTO tasks (
        id,fingerprint,kind,account,account_user_id,browser_profile,source_note_id,replaces_note_id,
        title,body,topics_json,images_json,video_json,cover_json,subtitle_json,manifest_path,package_dir,
        state,scheduled_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`).run(
        id, content.fingerprint, content.kind, content.account, account.userId, account.profile,
        content.sourceNoteId, content.replacesNoteId, content.title, content.body,
        serialize(content.topics), serialize(content.images), serialize(content.video), serialize(content.cover), serialize(content.subtitle),
        content.manifestPath, content.packageDir, content.publishAt, timestamp, timestamp,
      );
      addEvent(db, id, 'ingested', { fingerprint: content.fingerprint, warnings: content.warnings });
      return { ok: true, taskId: id, state: 'draft', fingerprint: content.fingerprint, warnings: content.warnings };
    }));
  }
  approve(id, { at, authorization = 'Current operator instruction', fingerprint, revision } = {}) {
    return this.withDatabase(db => transaction(db, () => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (!['draft', 'queued', 'failed'].includes(task.state)) throw new Error(`Task is ${task.state}; reconcile an unresolved attempt before authorizing a retry`);
      if (fingerprint && task.fingerprint !== fingerprint) throw new Error('Task content fingerprint changed; reopen the exact task');
      if (revision && reviewRevision(rowToTask(task)) !== revision) throw new Error('Task revision changed; reopen the exact task');
      const scheduledAt = at || task.scheduled_at || now();
      if (!Number.isFinite(Date.parse(scheduledAt))) throw new Error('Schedule must be a valid ISO date');
      const schedule = new Date(scheduledAt).toISOString();
      db.prepare("UPDATE tasks SET state='queued', scheduled_at=?, approved_at=?, authorization=?, last_error=NULL, updated_at=? WHERE id=?")
        .run(schedule, now(), String(authorization), now(), id);
      addEvent(db, id, 'authorized', { authorization: String(authorization), scheduledAt: schedule, previousState: task.state });
      return { ok: true, taskId: id, state: 'queued', scheduledAt: schedule };
    }));
  }
  update(id, state, fields = {}, event = state, payload = {}) {
    return this.withDatabase(db => transaction(db, () => {
      const allowed = new Set(['last_error','platform_note_id','readback_json','verification_json','baseline_ids_json','baseline_note_json','write_started_at','runner_pid','adapter_pid']);
      for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new Error(`Unknown task field ${key}`);
      db.prepare(`UPDATE tasks SET state=?, updated_at=?, ${Object.keys(fields).map(key => `${key}=?`).concat('runner_pid=NULL').join(',')} WHERE id=?`)
        .run(state, now(), ...Object.values(fields), id);
      addEvent(db, id, event, payload);
    }));
  }
  async inventory(alias, limit = 100) {
    const account = getAccount(alias);
    const identity = await verifiedIdentity(account);
    const notes = resultData(await readInventory(limit, account.profile), 'Inventory');
    if (!Array.isArray(notes)) throw new Error('Inventory did not return an array');
    return { ok: true, account: alias, identity, notes };
  }
  async note(alias, id) {
    checkNoteId(id);
    const account = getAccount(alias);
    const identity = await verifiedIdentity(account);
    const note = rowOf(resultData(await readNote(id, account.profile), 'Note readback'));
    if (note?.noteId !== id) throw new Error('Readback note ID did not match the requested note');
    return { ok: true, account: alias, identity, note };
  }
  frozenAccount(task) {
    const account = getAccount(task.account);
    if (account.userId !== task.account_user_id || account.profile !== task.browser_profile) {
      throw new Error('Account binding changed since ingest');
    }
    return account;
  }
  async findPublished(task, publication = null, attempts = 3) {
    const before = new Set(task.baseline_ids ?? []);
    if (!task.baseline_ids) throw new Error('Pre-submit inventory is missing; supply a verified note ID to reconcile');
    const proposed = publication?.noteId;
    if (proposed && /^[a-f0-9]{24}$/i.test(proposed) && !before.has(proposed)) return proposed;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const rows = resultData(await readInventory(100, task.browser_profile), 'Inventory');
      if (!Array.isArray(rows)) throw new Error('Inventory did not return an array');
      const matches = rows.filter(row => !before.has(String(row.id)) && row.title === task.title);
      if (matches.length === 1) return String(matches[0].id);
      if (matches.length > 1) throw new Error('Multiple new notes match the title; reconcile using the exact note ID');
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return null;
  }
  async completeReadback(task, noteId, publication = null) {
    checkNoteId(noteId);
    const row = rowOf(resultData(await readNote(noteId, task.browser_profile), 'Note readback'));
    const verification = compareReadback({ ...task, platform_note_id: noteId }, row, publication);
    const state = verification.matched ? 'verified' : 'submitted';
    const error = verification.matched ? null : 'Submission located; some requested fields still need review';
    this.update(task.id, state, { platform_note_id: noteId, readback_json: serialize(row), verification_json: serialize(verification), last_error: error },
      'platform_readback', { noteId, verification });
    return { ok: verification.matched, taskId: task.id, state, platformNoteId: noteId, verification, readback: row };
  }
  async execute(id, { dryRun = false } = {}) {
    let task;
    if (!id) {
      task = this.withDatabase(db => rowToTask(db.prepare("SELECT * FROM tasks WHERE state='queued' AND scheduled_at <= ? ORDER BY scheduled_at,created_at LIMIT 1").get(now())));
      if (!task) return { ok: true, executed: [], message: 'No due queued task' };
      id = task.id;
    }
    if (dryRun) {
      task = this.show(id).task;
      if (task.state !== 'queued') throw new Error('Only queued tasks can execute');
      this.frozenAccount(task);
      await verifyFrozenPackage(task);
      return { ok: true, taskId: id, state: task.state, dryRun: true, profile: task.browser_profile,
        argv: ['opencli', ...(task.kind === 'edit' ? editArgs(task) : publishArgs(task))] };
    }
    task = this.withDatabase(db => claimTask(db, id));
    let writeStarted = false;
    let publication = null;
    try {
      const account = this.frozenAccount(task);
      await verifyFrozenPackage(task);
      await verifiedIdentity(account);
      let beforeIds = null, beforeNote = null;
      if (task.kind === 'publish') {
        const rows = resultData(await readInventory(100, account.profile), 'Pre-submit inventory');
        if (!Array.isArray(rows)) throw new Error('Pre-submit inventory is not an array');
        beforeIds = rows.map(row => String(row.id));
      } else {
        beforeNote = rowOf(resultData(await readNote(task.source_note_id, account.profile), 'Pre-edit note'));
        if (beforeNote?.noteId !== task.source_note_id) throw new Error('Pre-edit note ID mismatch');
        if (task.images.length && beforeNote.mediaType === 'video') throw new Error('Video notes cannot replace media with images');
      }
      task = { ...task, baseline_ids: beforeIds, baseline_note: beforeNote };
      this.withDatabase(db => transaction(db, () => {
        db.prepare('UPDATE tasks SET baseline_ids_json=?,baseline_note_json=?,write_started_at=?,updated_at=? WHERE id=?')
          .run(serialize(beforeIds), serialize(beforeNote), now(), now(), id);
        addEvent(db, id, 'submission_started', { accountUserId: account.userId, mediaType: task.video ? 'video' : 'image' });
      }));
      writeStarted = true;
      const args = task.kind === 'edit' ? editArgs(task) : publishArgs(task);
      const response = await runOpencli(args, { profile: account.profile, timeoutMs: task.video ? 1_200_000 : 300_000,
        onSpawn: pid => this.withDatabase(db => db.prepare('UPDATE tasks SET adapter_pid=? WHERE id=?').run(pid, id)),
      });
      this.withDatabase(db => db.prepare('UPDATE tasks SET adapter_pid=NULL WHERE id=?').run(id));
      publication = rowOf(response.json);
      privateDirectory(path.join(this.root, 'receipts'));
      const receipt = path.join(this.root, 'receipts', `${id}-${task.attempts}.json`);
      await fs.writeFile(receipt, `${JSON.stringify({ taskId: id, createdAt: now(), response }, null, 2)}\n`, { mode: 0o600 });
      this.withDatabase(db => addEvent(db, id, 'adapter_finished', { receipt, exitCode: response.exitCode, timedOut: response.timedOut, publication }));
      if (response.exitCode !== 0) throw new Error(response.timedOut ? 'Adapter timed out; submission result is unknown' : response.stderr.trim() || `Adapter exited ${response.exitCode}`);
      await verifiedIdentity(account);
      const noteId = task.kind === 'edit' ? task.source_note_id : await this.findPublished(task, publication);
      if (!noteId) throw new Error('Submission returned but no unique platform note was located');
      return { ...await this.completeReadback(task, noteId, publication), receipt };
    } catch (error) {
      const state = writeStarted ? 'needs_review' : 'failed';
      this.update(id, state, { last_error: error.message }, state, { error: error.message });
      return { ok: false, taskId: id, state, error: error.message };
    }
  }
  async reconcile(id, { noteId, absent = false, reason } = {}) {
    let { task, events } = this.show(id);
    if (task.state === 'verified') return { ok: true, taskId: id, state: 'verified', unchanged: true, verification: task.verification };
    if (!['running', 'submitted', 'needs_review'].includes(task.state)) throw new Error(`Task is ${task.state}; reconciliation applies to unresolved attempts`);
    if (activeProcess(task.runner_pid) || activeProcess(task.adapter_pid)) throw new Error('The task worker or browser writer is still running; wait for its result before reconciling');
    const account = this.frozenAccount(task);
    if (task.state === 'running' && !task.write_started_at) {
      this.update(id, 'failed', { last_error: 'Worker exited before submission began' }, 'preflight_interrupted');
      return { ok: true, taskId: id, state: 'failed', retryRequiresAuthorization: true };
    }
    await verifiedIdentity(account);
    if (noteId) checkNoteId(noteId);
    const publication = [...events].reverse().find(event => event.event === 'adapter_finished')?.payload?.publication ?? null;
    if (task.kind === 'edit') {
      if (absent) throw new Error('An existing edit target cannot be declared absent; inspect and resolve the note fields');
      if (noteId && noteId !== task.source_note_id) throw new Error('Reconcile an edit using its original note ID');
      noteId = task.source_note_id;
    } else if (!noteId) {
      noteId = task.platform_note_id || await this.findPublished(task, publication, 1);
    } else if ((task.baseline_ids ?? []).includes(noteId)) {
      throw new Error('This note existed before the attempted publication');
    }
    if (noteId) {
      if (absent) throw new Error('A candidate note exists; reconcile it before considering another submission');
      return this.completeReadback(task, noteId, publication);
    }
    if (absent) {
      if (!String(reason ?? '').trim()) throw new Error('--absent requires --reason describing confirmation that no note or active composer remains');
      this.update(id, 'failed', { last_error: `Operator confirmed absent: ${reason}` }, 'absence_confirmed', { reason });
      return { ok: true, taskId: id, state: 'failed', retryRequiresAuthorization: true };
    }
    this.update(id, 'needs_review', { last_error: 'No matching note observed; this does not prove the submission was absent' }, 'reconciled_unresolved');
    return { ok: false, taskId: id, state: 'needs_review', message: 'No matching note observed; inspect the account and active composer before retrying' };
  }
  async collect(alias, limit = 120, { audit = false } = {}) {
    const account = getAccount(alias);
    await verifiedIdentity(account);
    const rows = resultData(await readMetrics(limit, account.profile), 'Metrics');
    if (!Array.isArray(rows)) throw new Error('Metrics did not return an array');
    if (audit) return { ok: true, account: alias, capturedAt: now(), scanned: rows.length,
      candidates: reviewCandidates(auditRows(rows)), policy: 'Review signals preserve the author’s intent; they do not authorize edits.' };
    const capturedAt = now();
    this.withDatabase(db => transaction(db, () => {
      const fields = ['note_id','account','title','published_at','views','likes','collects','comments','shares','avg_view_time','rise_fans','top_source','top_source_pct','top_interest','top_interest_pct','url','captured_at'];
      const statement = db.prepare(`INSERT INTO metrics (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}) ON CONFLICT(note_id) DO UPDATE SET ${fields.slice(1).map(key => `${key}=excluded.${key}`).join(',')}`);
      for (const row of rows) statement.run(String(row.id), alias, String(row.title ?? ''), String(row.published_at ?? row.date ?? ''),
        row.views ?? null,row.likes ?? null,row.collects ?? null,row.comments ?? null,row.shares ?? null,
        String(row.avg_view_time ?? ''),String(row.rise_fans ?? ''),String(row.top_source ?? ''),String(row.top_source_pct ?? ''),
        String(row.top_interest ?? ''),String(row.top_interest_pct ?? ''),String(row.url ?? ''),capturedAt);
    }));
    return { ok: true, account: alias, capturedAt, notes: rows.length };
  }
  report({ account, limit = 50 } = {}) {
    return this.withDatabase(db => {
      const filter = account ? ' WHERE account=?' : '';
      const params = account ? [account] : [];
      return { ok: true, generatedAt: now(),
        counts: db.prepare(`SELECT state,COUNT(*) AS count FROM tasks${filter} GROUP BY state`).all(...params),
        tasks: db.prepare(`SELECT id,account,kind,title,state,platform_note_id,last_error FROM tasks${filter} ORDER BY updated_at DESC LIMIT ?`).all(...params,limit),
        metrics: db.prepare(`SELECT * FROM metrics${filter} ORDER BY captured_at DESC LIMIT ?`).all(...params,limit) };
    });
  }
}
