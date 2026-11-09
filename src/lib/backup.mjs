import { DatabaseSync, backup } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const PRODUCT = 'rednote-steward';
const DATABASE = 'xhs-ops.sqlite';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `"${value.replaceAll('"', '""')}"`;
const within = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
async function exists(file) { return fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
async function canonicalPath(file) {
  try { return await fs.realpath(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await canonicalPath(path.dirname(file)), path.basename(file)); }
}
async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  return fs.readFile(file);
}
async function hashRegularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function emptyTarget(target, source) {
  const actualTarget = await canonicalPath(target), actualSource = await canonicalPath(source);
  if (!path.isAbsolute(target) || target === path.parse(target).root || within(actualSource, actualTarget) || within(actualTarget, actualSource)) {
    throw new Error('Choose a separate backup or restore directory outside the source state');
  }
  const stat = await exists(target);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(target)).length)) {
    throw new Error('The target must be an empty directory; existing state is preserved');
  }
}
function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const counts = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count]));
    const columns = tables.includes('tasks') ? new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)) : new Set();
    const tasks = tables.includes('tasks') ? db.prepare('SELECT * FROM tasks ORDER BY id').all() : [];
    const media = [];
    for (const task of tasks) {
      for (const field of ['images_json', 'video_json', 'cover_json', 'subtitle_json']) {
        if (!columns.has(field) || !task[field]) continue;
        const value = JSON.parse(task[field]);
        for (const asset of (Array.isArray(value) ? value : [value])) {
          if (asset?.path && asset?.sha256) media.push({ taskId: task.id, field, path: asset.path, sha256: asset.sha256 });
        }
      }
      if (columns.has('media_lineage_json') && task.media_lineage_json) {
        const lineage = JSON.parse(task.media_lineage_json);
        for (const entry of (Array.isArray(lineage) ? lineage : [])) {
          if (entry?.source && entry?.sourceSha256) media.push({ taskId: task.id, field: 'media_lineage_json.source', path: entry.source, sha256: entry.sourceSha256 });
          if (entry?.derived && entry?.derivedSha256) media.push({ taskId: task.id, field: 'media_lineage_json.derived', path: entry.derived, sha256: entry.derivedSha256 });
        }
      }
    }
    const receipts = [];
    if (tables.includes('events')) for (const event of db.prepare('SELECT task_id,payload_json FROM events WHERE payload_json IS NOT NULL').all()) {
      const payload = JSON.parse(event.payload_json);
      if (typeof payload?.receipt === 'string') receipts.push({ taskId: event.task_id, path: payload.receipt });
    }
    return { userVersion: db.prepare('PRAGMA user_version').get().user_version, counts, media, receipts,
      unresolved: tasks.filter(task => ['running', 'submitted', 'needs_review'].includes(task.state)).map(task => ({ taskId: task.id, state: task.state })),
      queued: tasks.filter(task => task.state === 'queued').length };
  } finally { db.close(); }
}
async function saveFile(stage, relative, bytes, files) {
  const file = path.join(stage, relative);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, bytes, { mode: 0o600 });
  files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
}

/** Snapshot SQLite through its backup API; media bytes and browser credentials are never copied. */
export async function createBackup({ stateRoot, destination, includeReceipts = true }) {
  const source = path.resolve(stateRoot);
  const sourceCanonicalRoot = await fs.realpath(source);
  const target = path.resolve(destination);
  await emptyTarget(target, source);
  const dbPath = path.join(source, DATABASE);
  const stat = await exists(dbPath);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('No regular task database exists in this state directory');
  const accountPath = path.join(source, 'accounts.json');
  const accountBytes = await exists(accountPath) ? await regularFile(accountPath) : null;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(path.dirname(target), '.rednote-backup-'));
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    try { await backup(db, path.join(stage, DATABASE)); } finally { db.close(); }
    const snapshot = inspectDatabase(path.join(stage, DATABASE));
    const files = [];
    await fs.chmod(path.join(stage, DATABASE), 0o600);
    const databaseBytes = await regularFile(path.join(stage, DATABASE));
    files.push({ path: DATABASE, bytes: databaseBytes.length, sha256: digest(databaseBytes) });
    if (accountBytes) await saveFile(stage, 'accounts.json', accountBytes, files);
    const copied = new Set();
    const missingReceipts = includeReceipts ? [] : snapshot.receipts.map(receipt => ({ ...receipt, reason: 'Receipt bytes were excluded from this backup' }));
    if (includeReceipts) for (const receipt of snapshot.receipts) {
      const receiptPath = path.resolve(receipt.path);
      const receiptsRoot = path.join(sourceCanonicalRoot, 'receipts');
      const realReceipt = await fs.realpath(receiptPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!realReceipt || !within(receiptsRoot, realReceipt) || realReceipt === receiptsRoot) {
        missingReceipts.push({ ...receipt, reason: 'Receipt reference is outside this state directory' }); continue;
      }
      const relative = path.relative(sourceCanonicalRoot, realReceipt);
      if (copied.has(relative)) continue;
      try {
        if (!within(sourceCanonicalRoot, realReceipt)) throw new Error('Receipt resolves outside the source state directory');
        await saveFile(stage, relative, await regularFile(receiptPath), files); copied.add(relative);
      }
      catch (error) { if (error.code === 'ENOENT') missingReceipts.push({ ...receipt, reason: 'Referenced receipt is missing' }); else throw error; }
    }
    const latestAccounts = await exists(accountPath) ? await regularFile(accountPath) : null;
    if (digest(accountBytes || '') !== digest(latestAccounts || '')) throw new Error('Account bindings changed during backup; create a fresh snapshot');
    const manifest = { schemaVersion: 1, product: PRODUCT, createdAt: new Date().toISOString(), sourceRoot: source, sourceCanonicalRoot,
      database: DATABASE, ...snapshot, files, missingReceipts, receiptsIncluded: includeReceipts, mediaIncluded: false, browserCredentialsIncluded: false };
    await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await emptyTarget(target, source);
    await fs.rename(stage, target);
    return { ok: true, backupRoot: target, manifest, note: 'Snapshot created. Media remains referenced at its source paths.' };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}
function mappingsOf(input) {
  if (!Array.isArray(input)) throw new Error('pathMappings must be an array of {from,to}');
  return input.map(mapping => {
    if (!mapping || typeof mapping.from !== 'string' || typeof mapping.to !== 'string' || !path.isAbsolute(mapping.from) || !path.isAbsolute(mapping.to)) {
      throw new Error('Every path mapping needs absolute from and to paths');
    }
    return { from: path.resolve(mapping.from), to: path.resolve(mapping.to) };
  }).sort((a, b) => b.from.length - a.from.length);
}
function mappedPath(value, mappings) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const mapping = mappings.find(item => within(item.from, value));
  return mapping ? path.join(mapping.to, path.relative(mapping.from, value)) : value;
}
async function loadBackup(backupRoot) {
  const root = await fs.realpath(path.resolve(backupRoot));
  const manifest = JSON.parse(await regularFile(path.join(root, 'manifest.json')));
  if (manifest.product !== PRODUCT || manifest.schemaVersion !== 1 || manifest.database !== DATABASE || !Array.isArray(manifest.files) ||
      typeof manifest.sourceRoot !== 'string' || !path.isAbsolute(manifest.sourceRoot)) {
    throw new Error('Backup manifest is not a supported RedNote Steward snapshot');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    const relative = file?.path;
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..') ||
        !([DATABASE, 'accounts.json'].includes(relative) || /^receipts\/[A-Za-z0-9_.-]+\.json$/.test(relative)) || seen.has(relative)) {
      throw new Error('Backup manifest contains an invalid or duplicate file path');
    }
    seen.add(relative);
    if (!within(root, await fs.realpath(path.join(root, relative)))) throw new Error('Backup file resolves outside the snapshot directory');
    const bytes = await regularFile(path.join(root, relative));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Backup file checksum mismatch: ${relative}`);
  }
  if (!seen.has(DATABASE)) throw new Error('Backup has no task database');
  const snapshot = inspectDatabase(path.join(root, DATABASE));
  return { root, manifest, snapshot };
}

/** Verify the snapshot and report path effects without changing source, target, or platform state. */
export async function previewRestore({ backupRoot, stateRoot, pathMappings = [] }) {
  const loaded = await loadBackup(backupRoot);
  const target = path.resolve(stateRoot);
  await emptyTarget(target, loaded.root);
  const mappings = mappingsOf(pathMappings);
  const mediaChecks = [], observed = new Map();
  for (const asset of loaded.snapshot.media) {
    const destination = mappedPath(asset.path, mappings);
    let status;
    try {
      if (!observed.has(destination)) observed.set(destination, await hashRegularFile(destination));
      status = observed.get(destination) === asset.sha256 ? 'matched' : 'mismatch';
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; status = 'missing'; }
    mediaChecks.push({ ...asset, destination, mapped: destination !== asset.path, status });
  }
  return { ok: true, dryRun: true, backupRoot: loaded.root, stateRoot: target, sourceRoot: loaded.manifest.sourceRoot,
    counts: loaded.snapshot.counts, unresolved: loaded.snapshot.unresolved, queued: loaded.snapshot.queued,
    pathMappings: mappings, mediaChecks, missingReceipts: loaded.manifest.missingReceipts || [],
    note: 'Restoration preserves authorization and history. Recheck account identity and state ownership before execution; no platform action is performed.' };
}
function rewritePaths(value, mappings, sourceRoot, targetRoot, key = '') {
  const pathFields = new Set(['path','receipt','manifestPath','packageDir','manifest_path','package_dir','source','derived','sidecarPath']);
  const stateMappings = key === 'receipt' ? [].concat(sourceRoot).filter(Boolean).map(from => ({ from, to: targetRoot })) : [];
  const allMappings = [...mappings, ...stateMappings].sort((a,b) => b.from.length-a.from.length);
  if (typeof value === 'string') return pathFields.has(key) ? mappedPath(value, allMappings) : value;
  if (Array.isArray(value)) return value.map(item => rewritePaths(item, mappings, sourceRoot, targetRoot, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, rewritePaths(item, mappings, sourceRoot, targetRoot, field)]));
  return value;
}

/** Restore only into an empty target. Running attempts become unresolved and never submit again here. */
export async function restoreBackup(options) {
  const preview = await previewRestore(options);
  if (preview.mediaChecks.some(item => item.mapped && item.status !== 'matched')) throw new Error('Mapped media is missing or changed; restore preview lists each failed checksum');
  const { root, manifest } = await loadBackup(options.backupRoot);
  const target = preview.stateRoot;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(path.dirname(target), '.rednote-restore-'));
  try {
    for (const file of manifest.files) {
      await fs.mkdir(path.dirname(path.join(stage, file.path)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(stage, file.path), await regularFile(path.join(root, file.path)), { mode: 0o600 });
    }
    const db = new DatabaseSync(path.join(stage, DATABASE));
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(item => item.name));
      if (tables.has('tasks')) {
        const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(item => item.name));
        db.exec('BEGIN IMMEDIATE');
        for (const task of db.prepare('SELECT * FROM tasks').all()) {
          const updates = {};
          for (const column of ['manifest_path','package_dir']) if (columns.has(column) && task[column]) updates[column] = mappedPath(task[column], preview.pathMappings);
          for (const column of ['images_json','video_json','cover_json','subtitle_json','baseline_note_json','readback_json','media_lineage_json']) {
            if (columns.has(column) && task[column]) updates[column] = JSON.stringify(rewritePaths(JSON.parse(task[column]), preview.pathMappings, [manifest.sourceRoot,manifest.sourceCanonicalRoot], target));
          }
          for (const column of ['runner_pid','adapter_pid']) if (columns.has(column)) updates[column] = null;
          if (task.state === 'running') updates.state = 'needs_review';
          if (Object.keys(updates).length) db.prepare(`UPDATE tasks SET ${Object.keys(updates).map(column => `${quote(column)}=?`).join(',')} WHERE id=?`).run(...Object.values(updates), task.id);
          if (tables.has('events')) db.prepare('INSERT INTO events (task_id,event,payload_json,created_at) VALUES (?,?,?,?)').run(task.id, 'state_restored', JSON.stringify({ previousState: task.state, backupCreatedAt: manifest.createdAt, processIdsCleared: true }), new Date().toISOString());
        }
        if (tables.has('events')) for (const event of db.prepare('SELECT id,payload_json FROM events WHERE payload_json IS NOT NULL').all()) {
          db.prepare('UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify(rewritePaths(JSON.parse(event.payload_json), preview.pathMappings, [manifest.sourceRoot,manifest.sourceCanonicalRoot], target)), event.id);
        }
        db.exec('COMMIT');
      }
      if (tables.has('catalog_notes') && db.prepare('PRAGMA table_info(catalog_notes)').all().some(column => column.name === 'source_path')) {
        for (const row of db.prepare('SELECT rowid,source_path FROM catalog_notes WHERE source_path IS NOT NULL').all()) {
          db.prepare('UPDATE catalog_notes SET source_path=? WHERE rowid=?').run(mappedPath(row.source_path, preview.pathMappings), row.rowid);
        }
      }
    } finally { db.close(); }
    await fs.writeFile(path.join(stage, 'restore.json'), `${JSON.stringify({ product: PRODUCT, restoredAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt, sourceRoot: manifest.sourceRoot, pathMappings: preview.pathMappings }, null, 2)}\n`, { mode: 0o600 });
    await emptyTarget(target, root);
    await fs.rename(stage, target);
    return { ...preview, dryRun: false, restored: true, platformWrites: false, note: 'History restored. Running attempts require reconciliation; verify account identity and owner before continuing.' };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}
