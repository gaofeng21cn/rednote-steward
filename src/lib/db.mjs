import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

function ensureColumns(db, table, definitions) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
      account TEXT NOT NULL, expected_account TEXT, source_note_id TEXT,
      title TEXT NOT NULL, body TEXT NOT NULL, topics_json TEXT NOT NULL, images_json TEXT NOT NULL,
      manifest_path TEXT NOT NULL, package_dir TEXT NOT NULL,
      state TEXT NOT NULL, scheduled_at TEXT, approved_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      adapter TEXT, platform_note_id TEXT, readback_json TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event TEXT NOT NULL,
      payload_json TEXT, created_at TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS metrics (
      note_id TEXT PRIMARY KEY, title TEXT, published_at TEXT, views INTEGER, likes INTEGER,
      collects INTEGER, comments INTEGER, url TEXT, captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_state_schedule ON tasks(state, scheduled_at);
    CREATE INDEX IF NOT EXISTS tasks_fingerprint ON tasks(account, kind, fingerprint);`);
  ensureColumns(db, 'tasks', {
    account_user_id: 'TEXT', browser_profile: 'TEXT', video_json: 'TEXT', cover_json: 'TEXT', subtitle_json: 'TEXT',
    replaces_note_id: 'TEXT', authorization: 'TEXT', runner_pid: 'INTEGER', adapter_pid: 'INTEGER',
    baseline_ids_json: 'TEXT', baseline_note_json: 'TEXT', write_started_at: 'TEXT', verification_json: 'TEXT',
  });
  ensureColumns(db, 'metrics', {
    account: 'TEXT', shares: 'INTEGER', avg_view_time: 'TEXT', rise_fans: 'TEXT',
    top_source: 'TEXT', top_source_pct: 'TEXT', top_interest: 'TEXT', top_interest_pct: 'TEXT',
  });
  db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  // Ingest also uses BEGIN IMMEDIATE so duplicate detection and insertion are indivisible.
  fs.chmodSync(dbPath, 0o600);
  return db;
}
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function addEvent(db, taskId, event, payload = null) {
  db.prepare('INSERT INTO events (task_id, event, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, event, payload == null ? null : JSON.stringify(payload), new Date().toISOString());
}
export function rowToTask(row) {
  if (!row) return null;
  const result = { ...row };
  for (const name of ['topics', 'images', 'video', 'cover', 'subtitle', 'readback', 'verification', 'baseline_ids', 'baseline_note']) {
    result[name] = row[`${name}_json`] ? JSON.parse(row[`${name}_json`]) : ['topics', 'images'].includes(name) ? [] : null;
    delete result[`${name}_json`];
  }
  return result;
}
export function claimTask(db, id, timestamp = new Date().toISOString()) {
  return transaction(db, () => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.state !== 'queued') throw new Error(`Task ${id} is ${task.state}; only queued tasks execute`);
    if (task.scheduled_at && task.scheduled_at > timestamp) throw new Error(`Task is scheduled for ${task.scheduled_at}`);
    const blocking = db.prepare(`SELECT id, state FROM tasks WHERE id <> ?
      AND (account_user_id = ? OR browser_profile = ? OR account = ?)
      AND state IN ('running', 'submitted', 'needs_review') LIMIT 1`)
      .get(id, task.account_user_id, task.browser_profile, task.account);
    if (blocking) throw new Error(`Account is blocked by ${blocking.id} (${blocking.state}); reconcile that attempt first`);
    const changed = db.prepare(`UPDATE tasks SET state = 'running', attempts = attempts + 1,
      adapter = 'opencli', runner_pid = ?, adapter_pid = NULL, updated_at = ?,
      baseline_ids_json = NULL, baseline_note_json = NULL, write_started_at = NULL,
      platform_note_id = NULL, readback_json = NULL, verification_json = NULL, last_error = NULL
      WHERE id = ? AND state = 'queued'`)
      .run(process.pid, timestamp, id);
    if (changed.changes !== 1) throw new Error('Task was already claimed');
    addEvent(db, id, 'execution_claimed', { pid: process.pid, previousAttempt: task.attempts ? { writeStartedAt: task.write_started_at, platformNoteId: task.platform_note_id, readback: task.readback_json ? JSON.parse(task.readback_json) : null } : null });
    return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });
}
