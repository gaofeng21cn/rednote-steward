import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { addEvent, openDatabase, transaction } from './db.mjs';

const SCHEMA_VERSION = 1;
const KNOWN_LEDGER_SCHEMA = 3;
const UNRESOLVED = new Set(['running', 'submitted', 'needs_review', 'result_unknown', 'uploaded_not_submitted', 'submitted_review']);
const VERIFIED = new Set(['verified', 'published_verified']);
const KNOWN_STATES = new Set([...UNRESOLVED, ...VERIFIED, 'draft', 'queued', 'failed', 'cancelled', 'superseded', 'pending_upload', 'ready_to_publish', 'source_changed']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function canonicalPath(file) {
  try { return await fsp.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalPath(path.dirname(file)), path.basename(file));
  }
}

function resolveMapping(value, mappings) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const mapping = mappings.find((item) => value === item.from || value.startsWith(`${item.from}${path.sep}`));
  return mapping ? path.join(mapping.to, path.relative(mapping.from, value)) : value;
}

function normaliseMappings(input = []) {
  if (!Array.isArray(input)) throw new Error('pathMappings must be an array of {from,to}');
  return input.map((item) => {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string' || !path.isAbsolute(item.from) || !path.isAbsolute(item.to)) {
      throw new Error('Every path mapping needs absolute from and to paths');
    }
    return { from: path.resolve(item.from), to: path.resolve(item.to) };
  }).sort((a, b) => b.from.length - a.from.length);
}

function requireAccount(account) {
  if (!account || typeof account !== 'object' || !SAFE_ID.test(account.alias ?? '') ||
      !/^[A-Za-z0-9_-]{4,128}$/.test(account.userId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(account.profile ?? '')) {
    throw new Error('Migration requires account {alias,userId,profile} using stable local identifiers');
  }
  return { alias: String(account.alias), userId: String(account.userId), profile: String(account.profile) };
}

async function readJsonSource(file) {
  const value = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!value || value.schema_version !== KNOWN_LEDGER_SCHEMA || !Array.isArray(value.rows)) {
    throw new Error(`Unsupported JSON ledger schema; expected schema_version ${KNOWN_LEDGER_SCHEMA}`);
  }
  return {
    kind: 'json-ledger-v3',
    schemaVersion: value.schema_version,
    rows: [...value.rows, ...(Array.isArray(value.retired_rows) ? value.retired_rows : [])],
    retiredCount: Array.isArray(value.retired_rows) ? value.retired_rows.length : 0,
    raw: value,
  };
}

function readSqliteSource(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    if (!tables.has('tasks')) throw new Error('Unsupported SQLite ledger: tasks table is missing');
    const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
    const required = ['id', 'fingerprint', 'kind', 'account', 'title', 'body', 'topics_json', 'images_json', 'manifest_path', 'package_dir', 'state', 'created_at', 'updated_at'];
    if (required.some((name) => !columns.has(name))) throw new Error('Unsupported SQLite ledger: tasks schema differs from known xhs-ops');
    if (db.prepare('PRAGMA user_version').get().user_version > 2) throw new Error('Unsupported SQLite ledger schema version');
    db.exec('BEGIN');
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();
    const events = tables.has('events') ? db.prepare('SELECT task_id,event,payload_json,created_at FROM events ORDER BY id').all() : [];
    const metrics = tables.has('metrics') ? db.prepare('SELECT * FROM metrics ORDER BY note_id').all() : [];
    db.exec('COMMIT');
    return { kind: 'sqlite-tasks', schemaVersion: db.prepare('PRAGMA user_version').get().user_version, rows, events, metrics, columns };
  } finally { db.close(); }
}

async function sourceInfo(input) {
  const source = await fsp.realpath(path.resolve(String(input ?? '')));
  const stat = await fsp.stat(source).catch((error) => { if (error.code === 'ENOENT') throw new Error(`Migration source not found: ${source}`); throw error; });
  if (!stat.isFile()) throw new Error('Migration source must be a JSON ledger or SQLite file');
  const lower = source.toLowerCase();
  const parsed = lower.endsWith('.json') ? await readJsonSource(source) : readSqliteSource(source);
  // The canonical snapshot includes WAL-visible rows rather than only the main SQLite file.
  const digest = sha256(JSON.stringify(parsed.raw ?? { kind: parsed.kind, schemaVersion: parsed.schemaVersion, rows: parsed.rows, events: parsed.events ?? [], metrics: parsed.metrics ?? [] }));
  return { source, digest, ...parsed };
}

function asJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function taskJson(row, field, fallback) {
  if (row[field] == null || row[field] === '') return fallback;
  try { return typeof row[field] === 'string' ? JSON.parse(row[field]) : row[field]; }
  catch { throw new Error(`Legacy task has invalid ${field}`); }
}

function statusOf(row) {
  const status = String(row.status ?? row.state ?? 'pending_upload');
  if (!KNOWN_STATES.has(status)) throw new Error(`Unsupported legacy task state: ${status}`);
  if (VERIFIED.has(status)) return 'verified';
  if (UNRESOLVED.has(status)) return 'needs_review';
  if (status === 'cancelled' || status === 'superseded') return 'cancelled';
  // A source task has no current user authorization in the new controller.
  return 'draft';
}

function noteIdOf(row) {
  const value = row.note_id ?? row.platform_note_id ?? row.source_note_id ?? null;
  return value && /^[a-f0-9]{24}$/i.test(String(value)) ? String(value).toLowerCase() : null;
}

function fingerprintOf(row) {
  const value = row.content_fingerprint ?? row.fingerprint;
  if (typeof value === 'string' && /^[a-f0-9]{32,128}$/i.test(value)) return value;
  const media = [row.sha256, row.copy_sha256, row.cover_sha256, row.subtitle_sha256].filter(Boolean).join('\0');
  return sha256(JSON.stringify({ platform: 'xiaohongshu', series: row.series ?? null, episode: row.episode ?? null,
    title: row.title ?? '', body: row.body ?? '', topics: row.planned_topics ?? '', media }));
}

function sourceRow(row, source) {
  const rawState = String(row.status ?? row.state ?? 'pending_upload');
  const noteId = noteIdOf(row);
  const state = VERIFIED.has(rawState) && !noteId ? 'needs_review' : statusOf(row);
  const kind = row.kind === 'edit' || row.source_note_id ? 'edit' : 'publish';
  const plannedTopics = String(row.planned_topics ?? '');
  const topics = Array.isArray(row.topics) ? row.topics : asJson(row.topics_json) ?? (plannedTopics.includes('#')
    ? [...plannedTopics.matchAll(/#([^#\s,，]+)/g)].map((match) => match[1])
    : plannedTopics.split(/[,，]/).map((item) => item.trim()).filter(Boolean));
  const images = asJson(row.images_json, row.images ?? []);
  const video = asJson(row.video_json, row.video_path ? { path: row.video_path, sha256: row.sha256 } : null);
  const cover = asJson(row.cover_json, row.cover_path ? { path: row.cover_path, sha256: row.cover_sha256 } : null);
  const subtitle = asJson(row.subtitle_json, row.subtitles_path ? { path: row.subtitles_path, sha256: row.subtitle_sha256 } : null);
  const mediaLineage = taskJson(row, 'media_lineage_json', row.mediaLineage ?? row.media_lineage ?? []);
  const declarations = taskJson(row, 'declarations_json', row.declarations ?? {});
  if (!Array.isArray(mediaLineage)) throw new Error('Legacy media lineage must be an array');
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations) || Object.entries(declarations).some(([key,value]) => !['original','aiGenerated'].includes(key) || typeof value !== 'boolean')) {
    throw new Error('Legacy declarations supports boolean original and aiGenerated fields');
  }
  return {
    sourceKey: `${row.series ?? row.account ?? ''}\0${row.episode ?? row.id ?? row.task_id ?? ''}`,
    sourceState: rawState,
    state,
    kind,
    noteId,
    sourceNoteId: row.source_note_id ?? (kind === 'edit' ? noteId : null),
    replacesNoteId: row.replaces_note_id ?? null,
    fingerprint: fingerprintOf(row),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    topics,
    images: Array.isArray(images) ? images : [],
    video: video && typeof video === 'object' ? video : null,
    cover: cover && typeof cover === 'object' ? cover : null,
    subtitle: subtitle && typeof subtitle === 'object' ? subtitle : null,
    mediaLineage: Array.isArray(mediaLineage) ? mediaLineage : [],
    declarations: declarations && typeof declarations === 'object' && !Array.isArray(declarations) ? declarations : {},
    seriesId: row.series_id ?? row.seriesId ?? row.series ?? null,
    episode: row.episode ?? null,
    contentType: row.content_type ?? row.contentType ?? null,
    manifestPath: String(row.manifest_path ?? row.frozen_package_path ?? row.copy_path ?? source.source),
    packageDir: String(row.package_dir ?? path.dirname(row.video_path ?? row.copy_path ?? source.source)),
    attempts: Number(row.attempts ?? row.attempt ?? row.active_attempt?.attempts ?? 0) || 0,
    authorization: row.authorization ?? row.release_approval?.authorization_source ?? (row.release_approval?.authorized_for_publication === true ? JSON.stringify(row.release_approval) : null),
    batchId: row.batch_id ?? row.series ?? null,
    platformNoteId: noteId,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    scheduledAt: row.scheduled_at ?? row.release_approval?.scheduled_at ?? null,
    approvedAt: row.approved_at ?? row.release_approval?.authorized_at ?? null,
    readback: asJson(row.readback_json, row.platform_readback ?? null),
    verification: asJson(row.verification_json, null),
    sourceEvents: source.events?.filter((item) => item.task_id === row.id) ?? [],
    raw: row,
  };
}

async function verifyMedia(row, mappings) {
  const assets = [];
  for (const asset of [...row.images, row.video, row.cover, row.subtitle].filter(Boolean)) {
    if (!asset.path || !asset.sha256) continue;
    const file = resolveMapping(path.resolve(asset.path), mappings);
    const actual = await digestFile(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    assets.push({ source: asset.path, destination: file, expected: asset.sha256, actual, status: actual === asset.sha256 ? 'matched' : actual ? 'mismatch' : 'missing' });
  }
  for (const relation of row.mediaLineage ?? []) {
    const source = relation.source ?? relation.sourcePath;
    const derived = relation.derived ?? relation.output ?? relation.derivedPath;
    if (!source || !derived) throw new Error('Legacy media lineage entry needs source and derived paths');
    for (const [role, value, expected] of [['lineage-source', source, relation.sourceSha256], ['lineage-derived', derived, relation.derivedSha256]]) {
      const file = resolveMapping(path.resolve(value), mappings);
      const actual = await digestFile(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error(`Legacy ${role} needs its frozen SHA-256`);
      assets.push({ source: value, destination: file, expected: expected ?? null, actual, status: actual ? (expected && actual !== expected ? 'mismatch' : 'matched') : 'missing', lineage: true, role });
    }
  }
  return assets;
}

function taskIdFor(sourcePath, row) {
  return /^xhs_[a-f0-9]{20}$/i.test(row.raw.id ?? '') ? row.raw.id : `xhs_${sha256(`${sourcePath}\0${row.sourceKey}\0${row.fingerprint}`).slice(0, 20)}`;
}

async function prepare(input) {
  const account = requireAccount(input.account);
  const mappings = normaliseMappings(input.pathMappings);
  const source = await sourceInfo(input.source);
  if (input.expectedSourceDigest && input.expectedSourceDigest !== source.digest) {
    throw new Error('Migration source digest changed; create a fresh preview before applying');
  }
  const sourceAccounts = [...new Set(source.rows.map((row) => row.account).filter(Boolean))];
  if (sourceAccounts.length > 1 && !input.sourceAccount) throw new Error('This legacy source contains multiple accounts; select sourceAccount explicitly');
  if (input.sourceAccount && !sourceAccounts.includes(input.sourceAccount)) throw new Error('Selected sourceAccount does not exist in this legacy source');
  const selectedRows = input.sourceAccount ? source.rows.filter((row) => row.account === input.sourceAccount) : source.rows;
  if (selectedRows.some((row) => row.account_user_id && row.account_user_id !== account.userId)) throw new Error('Source stable account ID differs from the target binding');
  const selectedMetrics = (source.metrics ?? []).filter((metric) => metric.account
    ? metric.account === (input.sourceAccount ?? sourceAccounts[0])
    : sourceAccounts.length <= 1);
  const ambiguousMetrics = (source.metrics ?? []).filter((metric) => !metric.account && sourceAccounts.length > 1).length;
  if (selectedMetrics.some((metric) => metric.account_user_id && metric.account_user_id !== account.userId)) throw new Error('Source metric stable account ID differs from the target binding');
  const rows = selectedRows.flatMap((row) => {
    const previous = Array.isArray(row.previous_versions) ? row.previous_versions.map((version, index) => sourceRow({
      series: row.series, episode: `${row.episode ?? ''}:previous:${index + 1}`, ...version,
    }, source)) : [];
    return [...previous, sourceRow(row, source)];
  });
  const mediaByRow = [];
  for (const row of rows) mediaByRow.push(await verifyMedia(row, mappings));
  const media = mediaByRow.flat();
  const operations = rows.map((row, index) => ({
    index, taskId: taskIdFor(source.source, row), ...row,
    media: mediaByRow[index],
    importAction: row.state === 'verified' && row.noteId ? 'history_verified' : row.state === 'needs_review' ? 'needs_review' : row.state === 'cancelled' ? 'history_cancelled' : 'draft',
  }));
  return { schemaVersion: SCHEMA_VERSION, source, account, mappings, operations, selectedMetrics, summary: {
    total: operations.length,
    byAction: Object.fromEntries([...new Set(operations.map((item) => item.importAction))].map((key) => [key, operations.filter((item) => item.importAction === key).length])),
    media: { matched: media.filter((item) => item.status === 'matched').length, missing: media.filter((item) => item.status === 'missing').length, mismatch: media.filter((item) => item.status === 'mismatch').length },
    metricSnapshots: selectedMetrics.length,
    ambiguousMetrics,
    sourceKind: source.kind,
    sourceAccounts,
    selectedSourceAccount: input.sourceAccount ?? sourceAccounts[0] ?? null,
  } };
}

/** Preview a known legacy SQLite or schema-3 JSON ledger. It never creates a target database. */
export async function previewLegacyImport(options) {
  return prepare(options);
}

function serialise(value) { return value == null ? null : JSON.stringify(value); }

/** Apply one previously reviewed preview. This imports history only; it never authorizes or submits. */
export async function applyLegacyImport(options) {
  if (options?.apply !== true) throw new Error('Explicit apply:true is required to import a legacy ledger');
  if (!/^[a-f0-9]{64}$/i.test(options.expectedSourceDigest ?? '')) throw new Error('Apply requires expectedSourceDigest returned by a fresh preview');
  const preview = await prepare(options);
  if (typeof options.stateRoot !== 'string' || !path.isAbsolute(options.stateRoot)) throw new Error('An absolute non-root stateRoot is required');
  const targetRoot = path.resolve(options.stateRoot);
  if (targetRoot === path.parse(targetRoot).root) throw new Error('An absolute non-root stateRoot is required');
  const targetCanonical = await canonicalPath(targetRoot);
  if (preview.source.source === path.join(targetCanonical, 'xhs-ops.sqlite') || preview.source.source.startsWith(`${targetCanonical}${path.sep}`)) throw new Error('Import source must be outside the target state directory');
  const targetDbPath = path.join(targetRoot, 'xhs-ops.sqlite');
  const targetDbStat = await fsp.lstat(targetDbPath).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (targetDbStat?.isSymbolicLink() || await canonicalPath(targetDbPath) === preview.source.source) throw new Error('Target database must be a separate regular file; database symlinks are preserved');
  if (preview.operations.some((item) => item.media.some((asset) => (asset.lineage || asset.destination !== asset.source) && asset.status !== 'matched'))) {
    throw new Error('Mapped media is missing or changed; inspect the preview checksum results');
  }
  const accountFile = path.join(targetRoot, 'accounts.json');
  try {
    const targetAccounts = JSON.parse(await fsp.readFile(accountFile, 'utf8'));
    const binding = targetAccounts.accounts?.find((item) => item.alias === preview.account.alias);
    if (!binding || binding.userId !== preview.account.userId || binding.profile !== preview.account.profile) throw new Error('Target account binding differs; bind or select the intended account before import');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fsp.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const db = openDatabase(path.join(targetRoot, 'xhs-ops.sqlite'));
  const imported = [];
  let importedMetrics = 0;
  try {
    transaction(db, () => {
      for (const item of preview.operations) {
        const existing = db.prepare('SELECT id, fingerprint, account_user_id FROM tasks WHERE id = ?').get(item.taskId);
        if (existing) {
          if (existing.fingerprint !== item.fingerprint || existing.account_user_id !== preview.account.userId) throw new Error(`Migration task collision: ${item.taskId}`);
          const prior = db.prepare("SELECT payload_json FROM events WHERE task_id=? AND event='legacy_imported' ORDER BY id DESC LIMIT 1").get(item.taskId);
          if (!prior || JSON.parse(prior.payload_json).sourceDigest !== preview.source.digest) throw new Error(`Task ${item.taskId} already exists from a different source snapshot; reconcile its history instead of overwriting it`);
          imported.push({ taskId: item.taskId, action: 'unchanged' });
          continue;
        }
        const state = item.importAction === 'history_verified' ? 'verified' : item.importAction === 'needs_review' ? 'needs_review' : item.importAction === 'history_cancelled' ? 'cancelled' : 'draft';
        const timestamp = new Date().toISOString();
        const mapAsset = (asset) => asset ? { ...asset, path: resolveMapping(asset.path, preview.mappings) } : null;
        const mappedLineage = item.mediaLineage.map((relation) => ({ ...relation,
          source: resolveMapping(relation.source ?? relation.sourcePath, preview.mappings),
          derived: resolveMapping(relation.derived ?? relation.output ?? relation.derivedPath, preview.mappings),
          ...(relation.sidecarPath ? { sidecarPath: resolveMapping(relation.sidecarPath, preview.mappings) } : {}),
        }));
        db.prepare(`INSERT INTO tasks (
          id,fingerprint,kind,account,account_user_id,browser_profile,source_note_id,replaces_note_id,
          title,body,topics_json,images_json,video_json,cover_json,subtitle_json,manifest_path,package_dir,
          state,scheduled_at,approved_at,authorization,attempts,platform_note_id,created_at,updated_at,
          phase,phase_at,attempt_id,last_error,media_lineage_json,declarations_json,batch_id,series_id,episode,content_type,readback_json,verification_json,
          baseline_ids_json,baseline_note_json,write_started_at,last_error_code,last_error_detail_json,paused_at,pause_reason
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          item.taskId, item.fingerprint, item.kind, preview.account.alias, preview.account.userId, preview.account.profile,
          item.sourceNoteId, item.replacesNoteId, item.title, item.body, serialise(item.topics), serialise(item.images.map(mapAsset)), serialise(mapAsset(item.video)), serialise(mapAsset(item.cover)), serialise(mapAsset(item.subtitle)),
          resolveMapping(item.manifestPath, preview.mappings), resolveMapping(item.packageDir, preview.mappings), state, item.scheduledAt, item.approvedAt,
          item.authorization, item.attempts, item.platformNoteId, item.createdAt ?? timestamp, item.updatedAt ?? timestamp, 'imported', timestamp, null,
          state === 'needs_review' ? `Imported unresolved legacy state: ${item.sourceState}` : null, serialise(mappedLineage), serialise(item.declarations), item.batchId, item.seriesId, item.episode, item.contentType,
          serialise(item.readback), serialise(item.verification),
          item.raw.baseline_ids_json ?? null, item.raw.baseline_note_json ?? null, item.raw.write_started_at ?? null,
          item.raw.last_error_code ?? null, item.raw.last_error_detail_json ?? null, item.raw.paused_at ?? null, item.raw.pause_reason ?? null,
        );
        addEvent(db, item.taskId, 'legacy_imported', {
          schemaVersion: preview.source.schemaVersion, sourceKind: preview.source.kind, source: preview.source.source,
          sourceDigest: preview.source.digest, sourceState: item.sourceState, importAction: item.importAction,
          rawRow: item.raw, previousVersions: item.raw.previous_versions ?? [], media: item.media,
        });
        for (const event of item.sourceEvents) addEvent(db, item.taskId, 'legacy_event', { sourceEvent: event.event, sourceCreatedAt: event.created_at, payload: asJson(event.payload_json, event.payload_json) });
        imported.push({ taskId: item.taskId, action: item.importAction, state });
      }
      if (preview.selectedMetrics.length) {
        const fields = ['note_id','account','account_user_id','title','published_at','views','likes','collects','comments','shares','avg_view_time','rise_fans','top_source','top_source_pct','top_interest','top_interest_pct','url','captured_at','source'];
        const insert = db.prepare(`INSERT OR IGNORE INTO metric_observations (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
        for (const metric of preview.selectedMetrics) {
          if (!/^[a-f0-9]{24}$/i.test(metric.note_id ?? '') || typeof metric.captured_at !== 'string') throw new Error('Legacy metric requires a stable note ID and capture timestamp');
          const values = fields.map((field) => field === 'account' ? preview.account.alias : field === 'account_user_id' ? preview.account.userId : field === 'source' ? 'legacy-import' : metric[field] ?? null);
          importedMetrics += Number(insert.run(...values).changes);
        }
      }
    });
  } finally { db.close(); }
  return { ok: true, source: { path: preview.source.source, digest: preview.source.digest, kind: preview.source.kind }, account: preview.account, imported, importedMetrics, summary: preview.summary, platformWrites: false,
    next: 'Imported fingerprints and authorization are historical evidence. Inspect and ingest a current-format package before a new publication; reconcile unresolved tasks against their original platform note first.' };
}
