import { transaction } from './db.mjs';

export const MAINTENANCE_STATUSES = ['unreviewed', 'keep', 'needs_fact_check', 'needs_copy', 'needs_media', 'updated', 'waiting_evidence', 'video_pending'];

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function noteIdentity(value) {
  const id = required(value, 'noteId').toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('noteId must be a 24-character platform note ID');
  return id;
}
function timestamp(value = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(value))) throw new Error('A valid observation time is required');
  return new Date(value).toISOString();
}
function jsonRow(row) {
  if (!row) return null;
  const { inventory_json, ...value } = row;
  return { ...value, inventory: inventory_json ? JSON.parse(inventory_json) : null };
}
function hasTable(db,name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

/** Local organization only. These tables do not create or authorize publication tasks. */
export function ensureCatalogSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_notes (
    account_user_id TEXT NOT NULL, note_id TEXT NOT NULL, account TEXT NOT NULL,
    title TEXT, published_at TEXT, platform_url TEXT, media_type TEXT,
    inventory_json TEXT, series_id TEXT, episode TEXT, content_type TEXT,
    maintenance_status TEXT NOT NULL DEFAULT 'unreviewed', maintenance_reason TEXT,
    source_path TEXT, latest_task_id TEXT, last_seen_at TEXT NOT NULL,
    last_readback_at TEXT, last_inspected_at TEXT,
    PRIMARY KEY (account_user_id, note_id)
  );
  CREATE INDEX IF NOT EXISTS catalog_notes_account_series ON catalog_notes(account_user_id,series_id,episode);
  CREATE TABLE IF NOT EXISTS catalog_series (
    account_user_id TEXT NOT NULL, series_id TEXT NOT NULL, account TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT, expected_episodes_json TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (account_user_id,series_id)
  );
  CREATE TABLE IF NOT EXISTS inspection_cursors (
    account_user_id TEXT PRIMARY KEY, account TEXT NOT NULL, watermark TEXT NOT NULL,
    boundary_note_ids_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_policies (
    account_user_id TEXT PRIMARY KEY, account TEXT NOT NULL, policy_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
}

export function importInventory(db, { account, accountUserId, notes, capturedAt, source = 'inventory' }) {
  const alias = required(account, 'account');
  const userId = required(accountUserId, 'accountUserId');
  if (!Array.isArray(notes)) throw new Error('notes must be an array');
  const captured = timestamp(capturedAt);
  // Validate the entire batch before changing the catalog.
  const rows = notes.map(note => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) throw new Error('Each inventory note must be an object');
    return { note, id: noteIdentity(note.noteId ?? note.id) };
  });
  ensureCatalogSchema(db);
  return transaction(db, () => {
    const statement = db.prepare(`INSERT INTO catalog_notes
      (account_user_id,note_id,account,title,published_at,platform_url,media_type,inventory_json,last_seen_at,last_readback_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_user_id,note_id) DO UPDATE SET
      account=excluded.account, title=COALESCE(excluded.title,catalog_notes.title),
      published_at=COALESCE(excluded.published_at,catalog_notes.published_at),
      platform_url=COALESCE(excluded.platform_url,catalog_notes.platform_url),
      media_type=COALESCE(excluded.media_type,catalog_notes.media_type),
      inventory_json=excluded.inventory_json,last_seen_at=excluded.last_seen_at,
      last_readback_at=COALESCE(excluded.last_readback_at,catalog_notes.last_readback_at)`);
    for (const { note, id } of rows) statement.run(userId,id,alias,
      typeof note.title === 'string' ? note.title : null,
      note.publishedAt ?? note.published_at ?? note.date ?? null,
      note.url ?? note.platformUrl ?? null, note.mediaType ?? note.media_type ?? null,
      JSON.stringify({ ...note, source }), captured, source === 'readback' ? captured : null);
    return { ok: true, account: alias, accountUserId: userId, imported: rows.length, capturedAt: captured, publicationTasksCreated: 0 };
  });
}

export function catalogNotes(db, { account, accountUserId, seriesId, contentType, status, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('limit must be an integer between 1 and 10000');
  if (status && !MAINTENANCE_STATUSES.includes(status)) throw new Error('Unknown maintenance status');
  if (!hasTable(db,'catalog_notes')) return {ok:true,notes:[]};
  const where = [], parameters = [];
  for (const [column,value] of [['account',account],['account_user_id',accountUserId],['series_id',seriesId],['content_type',contentType],['maintenance_status',status]]) {
    if (value != null) { where.push(`${column} = ?`); parameters.push(value); }
  }
  const rows = db.prepare(`SELECT * FROM catalog_notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(published_at,last_seen_at) DESC,note_id LIMIT ?`).all(...parameters,limit);
  return { ok: true, notes: rows.map(jsonRow) };
}

export function updateCatalogNote(db, { accountUserId, noteId, ...changes }) {
  const userId = required(accountUserId, 'accountUserId'), id = noteIdentity(noteId);
  const fields = new Map([
    ['seriesId','series_id'],['episode','episode'],['contentType','content_type'],['maintenanceStatus','maintenance_status'],
    ['reason','maintenance_reason'],['sourcePath','source_path'],['latestTaskId','latest_task_id'],
  ]);
  for (const key of Object.keys(changes)) if (!fields.has(key)) throw new Error(`Unknown catalog field: ${key}`);
  if (changes.maintenanceStatus != null && !MAINTENANCE_STATUSES.includes(changes.maintenanceStatus)) throw new Error('Unknown maintenance status');
  if (changes.seriesId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(changes.seriesId)) throw new Error('seriesId must use letters, numbers, _ or -');
  const values = Object.entries(changes).map(([key,value]) => {
    if (value != null && typeof value !== 'string' && !(key === 'episode' && Number.isInteger(value))) throw new Error(`${key} must be a string or null`);
    return [fields.get(key),value == null ? null : String(value)];
  });
  ensureCatalogSchema(db);
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM catalog_notes WHERE account_user_id=? AND note_id=?').get(userId,id)) throw new Error('Catalog note not found; import its platform identity first');
    if (values.length) db.prepare(`UPDATE catalog_notes SET ${values.map(([field]) => `${field}=?`).join(',')},last_inspected_at=? WHERE account_user_id=? AND note_id=?`)
      .run(...values.map(([,value]) => value),timestamp(),userId,id);
    return { ok: true, note: jsonRow(db.prepare('SELECT * FROM catalog_notes WHERE account_user_id=? AND note_id=?').get(userId,id)), publicationTasksCreated: 0 };
  });
}

export function upsertSeries(db, { account, accountUserId, seriesId, title, description = '', expectedEpisodes = [] }) {
  const userId = required(accountUserId,'accountUserId'), alias = required(account,'account');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(seriesId ?? '')) throw new Error('seriesId must use letters, numbers, _ or -');
  if (!Array.isArray(expectedEpisodes) || expectedEpisodes.some(value => !['string','number'].includes(typeof value))) throw new Error('expectedEpisodes must contain episode names');
  ensureCatalogSchema(db);
  const expected = [...new Set(expectedEpisodes.map(String))];
  db.prepare(`INSERT INTO catalog_series (account_user_id,series_id,account,title,description,expected_episodes_json,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_user_id,series_id) DO UPDATE SET account=excluded.account,title=excluded.title,
    description=excluded.description,expected_episodes_json=excluded.expected_episodes_json,updated_at=excluded.updated_at`)
    .run(userId,seriesId,alias,required(title,'title'),String(description),JSON.stringify(expected),timestamp());
  return seriesOverview(db,{accountUserId:userId,seriesId});
}

export function seriesOverview(db, { account, accountUserId, seriesId } = {}) {
  if (!hasTable(db,'catalog_series')) return {ok:true,series:[]};
  const where = [], params = [];
  for (const [column,value] of [['account',account],['account_user_id',accountUserId],['series_id',seriesId]]) if (value != null) { where.push(`${column}=?`); params.push(value); }
  const series = db.prepare(`SELECT * FROM catalog_series ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY account,series_id`).all(...params);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name));
  return { ok: true, series: series.map(row => {
    const { expected_episodes_json, ...item } = row;
    const expectedEpisodes = JSON.parse(expected_episodes_json || '[]');
    const notes = db.prepare('SELECT note_id,title,episode,maintenance_status,platform_url FROM catalog_notes WHERE account_user_id=? AND series_id=? ORDER BY episode,note_id').all(row.account_user_id,row.series_id);
    const present = new Set(notes.map(note => note.episode).filter(value => value != null));
    const tasks = taskColumns.has('series_id') ? db.prepare(`SELECT id,title,episode,state,platform_note_id FROM tasks WHERE account_user_id=? AND series_id=? ORDER BY episode,created_at`).all(row.account_user_id,row.series_id) : [];
    const prepared = new Set(tasks.filter(task=>!['cancelled','failed'].includes(task.state)).map(task=>task.episode).filter(value=>value!=null));
    return { ...item, expectedEpisodes, notes, tasks, unpublishedEpisodes: expectedEpisodes.filter(value=>!present.has(value)),
      missingEpisodes: expectedEpisodes.filter(value => !present.has(value) && !prepared.has(value)) };
  }) };
}

export function setInspectionCursor(db, { account, accountUserId, watermark, boundaryNoteIds = [] }) {
  const userId = required(accountUserId,'accountUserId'), alias = required(account,'account');
  if (!Array.isArray(boundaryNoteIds)) throw new Error('boundaryNoteIds must be an array');
  const boundary = [...new Set(boundaryNoteIds.map(noteIdentity))].sort(), value = timestamp(watermark);
  ensureCatalogSchema(db);
  const previous = db.prepare('SELECT watermark FROM inspection_cursors WHERE account_user_id=?').get(userId);
  if (previous && value < previous.watermark) throw new Error('Inspection watermark cannot move backwards');
  db.prepare(`INSERT INTO inspection_cursors (account_user_id,account,watermark,boundary_note_ids_json,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(account_user_id) DO UPDATE SET account=excluded.account,watermark=excluded.watermark,boundary_note_ids_json=excluded.boundary_note_ids_json,updated_at=excluded.updated_at`)
    .run(userId,alias,value,JSON.stringify(boundary),timestamp());
  return getInspectionCursor(db,{accountUserId:userId});
}
export function getInspectionCursor(db, { accountUserId }) {
  required(accountUserId,'accountUserId');
  if (!hasTable(db,'inspection_cursors')) return {ok:true,cursor:null};
  const row = db.prepare('SELECT * FROM inspection_cursors WHERE account_user_id=?').get(required(accountUserId,'accountUserId'));
  if (!row) return { ok: true, cursor: null };
  const { boundary_note_ids_json, ...cursor } = row;
  return { ok: true, cursor: { ...cursor, boundaryNoteIds: JSON.parse(boundary_note_ids_json) } };
}
export function inspectionCandidates(db, { accountUserId, limit=6 } = {}) {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Inspection limit must be between 1 and 100');
  const userId=required(accountUserId,'accountUserId');
  const {cursor}=getInspectionCursor(db,{accountUserId:userId});
  const {policy}=getAccountPolicy(db,{accountUserId:userId});
  if (policy?.inspectionMode==='off') return {ok:true,notes:[],cursor,reason:'Inspection is disabled for this account',schedulingCreated:false};
  const boundary=new Set(cursor?.boundaryNoteIds??[]);
  const rows=catalogNotes(db,{accountUserId:userId,limit:10_000}).notes.filter(note=> {
    if (['keep','updated'].includes(note.maintenance_status)) return false;
    if (note.content_type && (policy?.preserveContentTypes??[]).includes(note.content_type)) return false;
    if (!cursor) return true;
    const published=Date.parse(note.published_at??'');
    // Missing platform dates stay visible as uninspected; they never become
    // fabricated publication timestamps or advance the watermark.
    if (!Number.isFinite(published)) return !note.last_inspected_at;
    const cutoff=Date.parse(cursor.watermark);
    return published>cutoff || (published===cutoff && !boundary.has(note.note_id));
  });
  return {ok:true,notes:rows.slice(0,limit),remaining:Math.max(0,rows.length-limit),cursor,
    judgment:'These are inspection candidates. Retaining an existing post is a valid outcome.',schedulingCreated:false};
}
export function setAccountPolicy(db, { account, accountUserId, policy }) {
  const userId = required(accountUserId,'accountUserId'), alias = required(account,'account');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy must be an object');
  if (policy.inspectionMode != null && !['off','manual','incremental'].includes(policy.inspectionMode)) throw new Error('inspectionMode must be off, manual or incremental');
  for (const field of ['preserveContentTypes','contextRefs']) if (policy[field] != null && (!Array.isArray(policy[field]) || policy[field].some(value=>typeof value!=='string'))) throw new Error(`${field} must be an array of strings`);
  ensureCatalogSchema(db);
  db.prepare(`INSERT INTO account_policies (account_user_id,account,policy_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(account_user_id) DO UPDATE SET account=excluded.account,policy_json=excluded.policy_json,updated_at=excluded.updated_at`)
    .run(userId,alias,JSON.stringify(policy),timestamp());
  return getAccountPolicy(db,{accountUserId:userId});
}
export function getAccountPolicy(db, { accountUserId }) {
  required(accountUserId,'accountUserId');
  if (!hasTable(db,'account_policies')) return {ok:true,policy:null,schedulingCreated:false};
  const row = db.prepare('SELECT * FROM account_policies WHERE account_user_id=?').get(required(accountUserId,'accountUserId'));
  return { ok: true, policy: row ? { ...JSON.parse(row.policy_json), account: row.account, accountUserId: row.account_user_id, updatedAt: row.updated_at } : null,
    schedulingCreated: false };
}
