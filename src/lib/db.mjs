import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 2;

function ensureColumns(db, table, definitions) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const existingSchemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (existingSchemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema ${existingSchemaVersion} is newer than this RedNote Steward version ${SCHEMA_VERSION}; upgrade the application before opening it`);
  }
  // A first-time journal-mode change can return SQLITE_BUSY immediately,
  // bypassing busy_timeout when another initializer holds the database.
  const deadline = Date.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try { db.exec('PRAGMA journal_mode = WAL'); break; }
    catch (error) {
      const sqliteCode = Number(error.errcode) & 255;
      if (![5, 6].includes(sqliteCode) || Date.now() >= deadline) { db.close(); throw error; }
      Atomics.wait(pause, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
  let transactionStarted = false;
  try {
  db.exec('BEGIN IMMEDIATE');
  transactionStarted = true;
  const lockedSchemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (lockedSchemaVersion > SCHEMA_VERSION) throw new Error(`Database schema ${lockedSchemaVersion} is newer than this RedNote Steward version ${SCHEMA_VERSION}; upgrade the application before opening it`);
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
    CREATE TABLE IF NOT EXISTS metric_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, account TEXT,
      account_user_id TEXT, title TEXT, published_at TEXT, views INTEGER, likes INTEGER,
      collects INTEGER, comments INTEGER, shares INTEGER, avg_view_time TEXT, rise_fans TEXT,
      top_source TEXT, top_source_pct TEXT, top_interest TEXT, top_interest_pct TEXT,
      url TEXT, content_revision TEXT, captured_at TEXT NOT NULL, source TEXT
    );
    CREATE TABLE IF NOT EXISTS queue_pauses (
      id TEXT PRIMARY KEY, account TEXT, batch_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_state_schedule ON tasks(state, scheduled_at);
    CREATE INDEX IF NOT EXISTS tasks_fingerprint ON tasks(account, kind, fingerprint);`);
  ensureColumns(db, 'tasks', {
    account_user_id: 'TEXT', browser_profile: 'TEXT', video_json: 'TEXT', cover_json: 'TEXT', subtitle_json: 'TEXT',
    replaces_note_id: 'TEXT', authorization: 'TEXT', runner_pid: 'INTEGER', adapter_pid: 'INTEGER',
    baseline_ids_json: 'TEXT', baseline_note_json: 'TEXT', write_started_at: 'TEXT', verification_json: 'TEXT',
    batch_id: 'TEXT', phase: 'TEXT', phase_at: 'TEXT', attempt_id: 'TEXT',
    last_error_code: 'TEXT', last_error_detail_json: 'TEXT', worker_launch_json: 'TEXT',
    worker_launched_at: 'TEXT', paused_at: 'TEXT', pause_reason: 'TEXT',
    media_lineage_json: 'TEXT', declarations_json: 'TEXT', series_id: 'TEXT', episode: 'TEXT', content_type: 'TEXT',
  });
  ensureColumns(db, 'metrics', {
    account: 'TEXT', account_user_id: 'TEXT', shares: 'INTEGER', avg_view_time: 'TEXT', rise_fans: 'TEXT',
    top_source: 'TEXT', top_source_pct: 'TEXT', top_interest: 'TEXT', top_interest_pct: 'TEXT',
  });
  if (lockedSchemaVersion < 2) {
    db.exec(`INSERT OR IGNORE INTO metric_observations (
      note_id,account,title,published_at,views,likes,collects,comments,shares,avg_view_time,rise_fans,
      top_source,top_source_pct,top_interest,top_interest_pct,url,captured_at,source
    ) SELECT note_id,account,title,published_at,views,likes,collects,comments,shares,avg_view_time,rise_fans,
      top_source,top_source_pct,top_interest,top_interest_pct,url,captured_at,'legacy-latest'
      FROM metrics;`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec('COMMIT');
  transactionStarted = false;
  db.exec('CREATE INDEX IF NOT EXISTS tasks_batch ON tasks(batch_id, created_at);');
  db.exec('CREATE INDEX IF NOT EXISTS metric_observations_note ON metric_observations(note_id, captured_at);');
  } catch (error) { if (transactionStarted) db.exec('ROLLBACK'); db.close(); throw error; }
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
  for (const name of ['topics', 'images', 'video', 'cover', 'subtitle', 'readback', 'verification', 'baseline_ids', 'baseline_note', 'last_error_detail', 'worker_launch', 'media_lineage', 'declarations']) {
    result[name] = row[`${name}_json`] ? JSON.parse(row[`${name}_json`]) : ['topics', 'images'].includes(name) ? [] : null;
    delete result[`${name}_json`];
  }
  return result;
}
function blockingTask(db, task) {
  return db.prepare(`SELECT id, state FROM tasks WHERE id <> ?
      AND (account_user_id = ? OR browser_profile = ? OR account = ?)
      AND state IN ('running', 'submitted', 'needs_review') LIMIT 1`)
    .get(task.id, task.account_user_id, task.browser_profile, task.account);
}
export function taskPause(db, task) {
  return db.prepare(`SELECT account,batch_id,reason,created_at FROM queue_pauses
    WHERE (account IS NULL OR account=?) AND (batch_id IS NULL OR batch_id=?) LIMIT 1`)
    .get(task.account,task.batch_id);
}
function claimRow(db, task, timestamp, requestedAttemptId = null) {
  const pause = taskPause(db,task);
  if (pause) throw new Error(`Task queue is paused: ${pause.reason}`);
  const blocking = blockingTask(db, task);
  if (blocking) throw new Error(`Account is blocked by ${blocking.id} (${blocking.state}); reconcile that attempt first`);
  const attemptId = requestedAttemptId || `attempt_${randomUUID().replaceAll('-', '')}`;
  const changed = db.prepare(`UPDATE tasks SET state = 'running', attempts = attempts + 1,
      adapter = 'opencli', runner_pid = ?, adapter_pid = NULL, updated_at = ?,
      phase = 'claimed', phase_at = ?, attempt_id = ?, last_error = NULL,
      last_error_code = NULL, last_error_detail_json = NULL,
      paused_at = NULL, pause_reason = NULL,
      baseline_ids_json = NULL, baseline_note_json = NULL, write_started_at = NULL,
      platform_note_id = NULL, readback_json = NULL, verification_json = NULL
      WHERE id = ? AND state = 'queued'`).run(process.pid, timestamp, timestamp, attemptId, task.id);
  if (changed.changes !== 1) throw new Error('Task was already claimed');
  addEvent(db, task.id, 'execution_claimed', {
    pid: process.pid, attemptId,
    previousAttempt: task.attempts ? { attemptId: task.attempt_id, phase: task.phase,
      writeStartedAt: task.write_started_at, platformNoteId: task.platform_note_id,
      readback: task.readback_json ? JSON.parse(task.readback_json) : null } : null,
  });
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
}
export function claimNextTask(db, { account = null, batchId = null, excludeIds = [], timestamp = new Date().toISOString() } = {}) {
  return transaction(db, () => {
    const filters = ["t.state = 'queued'", '(t.scheduled_at IS NULL OR t.scheduled_at <= ?)'];
    const params = [timestamp];
    if (account) { filters.push('t.account = ?'); params.push(account); }
    if (batchId) { filters.push('t.batch_id = ?'); params.push(batchId); }
    if (excludeIds.length) { filters.push(`t.id NOT IN (${excludeIds.map(() => '?').join(',')})`); params.push(...excludeIds); }
    filters.push(`NOT EXISTS (SELECT 1 FROM tasks b WHERE b.id <> t.id
      AND (b.account_user_id = t.account_user_id OR b.browser_profile = t.browser_profile OR b.account = t.account)
      AND b.state IN ('running', 'submitted', 'needs_review'))`);
    filters.push(`NOT EXISTS (SELECT 1 FROM queue_pauses p WHERE (p.account IS NULL OR p.account=t.account)
      AND (p.batch_id IS NULL OR p.batch_id=t.batch_id))`);
    const task = db.prepare(`SELECT t.* FROM tasks t WHERE ${filters.join(' AND ')}
      ORDER BY t.scheduled_at, t.created_at LIMIT 1`).get(...params);
    if (!task) return null;
    return claimRow(db, task, timestamp);
  });
}
export function claimTask(db, id, timestamp = new Date().toISOString(), attemptId) {
  return transaction(db, () => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.state !== 'queued') throw new Error(`Task ${id} is ${task.state}; only queued tasks execute`);
    if (task.scheduled_at && task.scheduled_at > timestamp) throw new Error(`Task is scheduled for ${task.scheduled_at}`);
    return claimRow(db, task, timestamp, attemptId);
  });
}

export function setTaskPhase(db, taskId, phase, detail = null) {
  return transaction(db, () => {
    const timestamp = new Date().toISOString();
    db.prepare('UPDATE tasks SET phase=?, phase_at=?, updated_at=? WHERE id=?')
      .run(String(phase), timestamp, timestamp, taskId);
    addEvent(db, taskId, 'phase', { phase: String(phase), ...(detail == null ? {} : { detail }) });
    return { phase: String(phase), phaseAt: timestamp };
  });
}

export function recordWorkerLaunch(db, taskId, launch = {}) {
  return transaction(db, () => {
    const task = db.prepare('SELECT worker_launch_json FROM tasks WHERE id=?').get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const previous = task.worker_launch_json ? JSON.parse(task.worker_launch_json) : null;
    if (previous?.log && previous.log === launch.log && ['finished','failed'].includes(previous.status)
      && ['starting','started'].includes(launch.status)) return previous;
    launch = { ...(previous?.log && previous.log === launch.log ? previous : {}), ...launch };
    const timestamp = new Date().toISOString();
    db.prepare('UPDATE tasks SET worker_launch_json=?, worker_launched_at=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(launch), timestamp, timestamp, taskId);
    addEvent(db, taskId, 'worker_launch', launch);
    return { ...launch, launchedAt: timestamp };
  });
}
