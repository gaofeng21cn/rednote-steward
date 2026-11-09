import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyLegacyImport, previewLegacyImport } from '../src/lib/migration.mjs';
import { openDatabase } from '../src/lib/db.mjs';
import { createHash } from 'node:crypto';
import { inspectPackage } from '../src/lib/package.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('schema 3 JSON preview maps unresolved states and verifies mapped media without creating state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'legacy'), targetRoot = path.join(root, 'new-media');
  await fs.mkdir(sourceRoot, { recursive: true }); await fs.mkdir(targetRoot, { recursive: true });
  const media = Buffer.from('synthetic-video'); const sourceMedia = path.join(sourceRoot, 'video.mp4'); const mappedMedia = path.join(targetRoot, 'video.mp4');
  await fs.writeFile(sourceMedia, media); await fs.writeFile(mappedMedia, media);
  const crypto = await import('node:crypto'); const digest = crypto.createHash('sha256').update(media).digest('hex');
  const ledger = path.join(root, 'content_ledger.json');
  await fs.writeFile(ledger, JSON.stringify({ schema_version: 3, rows: [
    { series: 'Series', episode: '01', status: 'submitted_review', title: 'First', body: 'Caption', planned_topics: 'Topic', video_path: sourceMedia, sha256: digest, content_fingerprint: 'a'.repeat(64), active_attempt: { attempts: 1 }, previous_versions: [{ status: 'pending_upload' }] },
    { series: 'Series', episode: '02', status: 'published_verified', title: 'Second', body: 'Caption', note_id: '0123456789abcdef01234567', content_fingerprint: 'b'.repeat(64) },
  ], retired_rows: [] }));
  const preview = await previewLegacyImport({ source: ledger, account: { alias: 'medical', userId: 'medical-user', profile: 'medical-profile' }, pathMappings: [{ from: sourceRoot, to: targetRoot }] });
  assert.equal(preview.summary.total, 3); assert.equal(preview.summary.byAction.needs_review, 1); assert.equal(preview.summary.byAction.history_verified, 1); assert.equal(preview.summary.media.matched, 1);
  await assert.rejects(fs.stat(path.join(root, 'state', 'xhs-ops.sqlite')), { code: 'ENOENT' });
});

test('apply requires explicit confirmation, is idempotent, and never queues imported work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'ledger.json');
  await fs.writeFile(ledger, JSON.stringify({ schema_version: 3, rows: [{ series: 'S', episode: '1', status: 'pending_upload', title: 'Draft', body: 'Body', content_fingerprint: 'c'.repeat(64) }], retired_rows: [] }));
  const options = { source: ledger, stateRoot: path.join(root, 'state'), account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } };
  await assert.rejects(applyLegacyImport(options), /apply:true/);
  const preview = await previewLegacyImport(options); const first = await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest });
  assert.equal(first.imported[0].state, 'draft'); assert.equal(first.platformWrites, false);
  const second = await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest });
  assert.equal(second.imported[0].action, 'unchanged');
  const db = openDatabase(path.join(root, 'state', 'xhs-ops.sqlite'));
  const task = db.prepare('SELECT state,account_user_id,authorization FROM tasks').get(); const event = db.prepare("SELECT event FROM events WHERE event='legacy_imported'").get(); db.close();
  assert.deepEqual({ ...task }, { state: 'draft', account_user_id: 'demo-user', authorization: null }); assert.ok(event);
});

test('unknown JSON schema is rejected rather than guessed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'unknown.json'); await fs.writeFile(source, JSON.stringify({ rows: [] }));
  await assert.rejects(previewLegacyImport({ source, account: { alias: 'a', userId: 'user', profile: 'profile' } }), /Unsupported JSON ledger schema/);
});

test('legacy SQLite tasks import with unresolved state protection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.sqlite'); const db = new DatabaseSync(source);
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,fingerprint TEXT,kind TEXT,account TEXT,source_note_id TEXT,title TEXT,body TEXT,topics_json TEXT,images_json TEXT,manifest_path TEXT,package_dir TEXT,state TEXT,attempts INTEGER,platform_note_id TEXT,created_at TEXT,updated_at TEXT)');
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old-1', 'd'.repeat(64), 'publish', 'old', null, 'Old', 'Body', '["Topic"]', '[]', source, root, 'running', 2, null, new Date().toISOString(), new Date().toISOString()); db.close();
  const preview = await previewLegacyImport({ source, account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } });
  assert.equal(preview.operations[0].importAction, 'needs_review');
  const applied = await applyLegacyImport({ source, stateRoot: path.join(root, 'state'), account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' }, apply: true, expectedSourceDigest: preview.source.digest });
  assert.equal(applied.imported[0].state, 'needs_review');
});

test('changed source snapshots and mismatched mapped media are rejected before target creation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'old'), moved = path.join(root, 'new');
  await fs.mkdir(original); await fs.mkdir(moved);
  await fs.writeFile(path.join(original, 'video.mp4'), 'original'); await fs.writeFile(path.join(moved, 'video.mp4'), 'different');
  const source = path.join(root, 'ledger.json'), stateRoot = path.join(root, 'state');
  const row = { series: 'S', episode: '1', status: 'pending_upload', title: 'Draft', body: 'Body', content_fingerprint: 'e'.repeat(64), video_path: path.join(original, 'video.mp4'), sha256: createHash('sha256').update('original').digest('hex') };
  await fs.writeFile(source, JSON.stringify({ schema_version: 3, rows: [row] }));
  const options = { source, stateRoot, account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' }, pathMappings: [{ from: original, to: moved }] };
  const preview = await previewLegacyImport(options);
  assert.equal(preview.summary.media.mismatch, 1);
  await assert.rejects(applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }), /Mapped media/);
  await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' });
  await fs.writeFile(source, JSON.stringify({ schema_version: 3, rows: [{ ...row, title: 'Changed' }] }));
  await assert.rejects(applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }), /digest changed/);
});

test('SQLite WAL rows, authorization events and latest metric remain recoverable history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.sqlite'), db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks (id TEXT PRIMARY KEY,fingerprint TEXT,kind TEXT,account TEXT,title TEXT,body TEXT,topics_json TEXT,images_json TEXT,manifest_path TEXT,package_dir TEXT,state TEXT,attempts INTEGER,platform_note_id TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE events (id INTEGER PRIMARY KEY,task_id TEXT,event TEXT,payload_json TEXT,created_at TEXT); CREATE TABLE metrics (note_id TEXT,title TEXT,captured_at TEXT,views INTEGER);");
  const timestamp = '2026-01-01T00:00:00.000Z', id = 'xhs_0123456789abcdef0123', noteId = '0123456789abcdef01234567';
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'f'.repeat(64), 'publish', 'old', 'Past', 'Body', '[]', '[]', source, root, 'verified', 2, noteId, timestamp, timestamp);
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(1, id, 'approved', JSON.stringify({ authorization: 'Synthetic owner instruction' }), timestamp);
  db.prepare('INSERT INTO metrics VALUES (?,?,?,?)').run(noteId, 'Past', timestamp, 0);
  const options = { source, stateRoot: path.join(root, 'target'), account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } };
  const preview = await previewLegacyImport(options);
  assert.equal(preview.summary.metricSnapshots, 1); assert.equal(preview.operations[0].attempts, 2);
  const mainHash = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  db.prepare('UPDATE metrics SET views=1').run();
  assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), mainHash);
  await assert.rejects(applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }), /digest changed/);
  const current = await previewLegacyImport(options);
  const applied = await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: current.source.digest });
  db.close();
  assert.equal(applied.imported[0].state, 'verified'); assert.equal(applied.importedMetrics, 1);
  const target = openDatabase(path.join(options.stateRoot, 'xhs-ops.sqlite'));
  assert.equal(target.prepare('SELECT attempts FROM tasks WHERE id=?').get(id).attempts, 2);
  assert.equal(target.prepare('SELECT views FROM metric_observations').get().views, 1);
  assert.equal(JSON.parse(target.prepare("SELECT payload_json FROM events WHERE event='legacy_event'").get().payload_json).payload.authorization, 'Synthetic owner instruction');
  target.close();
});

test('a verified source without a valid note ID remains unresolved and a symlink cannot make source the target', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'); await fs.mkdir(old);
  const source = path.join(old, 'ledger.json'); await fs.writeFile(source, JSON.stringify({ schema_version: 3, rows: [{ series: 'S', episode: '1', status: 'published_verified', title: 'Already submitted', body: 'Body', content_fingerprint: '1'.repeat(64) }] }));
  const options = { source, account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } };
  const preview = await previewLegacyImport(options);
  assert.equal(preview.operations[0].importAction, 'needs_review');
  const target = path.join(root, 'target'); await fs.symlink(old, target);
  await assert.rejects(applyLegacyImport({ ...options, stateRoot: target, apply: true, expectedSourceDigest: preview.source.digest }), /outside the target/);
  await assert.rejects(fs.stat(path.join(old, 'xhs-ops.sqlite')), { code: 'ENOENT' });
});

test('unattributed metrics in a multi-account ledger are reported as ambiguous and not reassigned', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.sqlite'), db = new DatabaseSync(source);
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,fingerprint TEXT,kind TEXT,account TEXT,title TEXT,body TEXT,topics_json TEXT,images_json TEXT,manifest_path TEXT,package_dir TEXT,state TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE metrics (note_id TEXT,title TEXT,captured_at TEXT,views INTEGER)');
  const insert = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const account of ['first', 'second']) insert.run(`old-${account}`, '2'.repeat(64), 'publish', account, 'Draft', 'Body', '[]', '[]', source, root, 'draft', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO metrics VALUES (?,?,?,?)').run('0123456789abcdef01234567', 'Metric', '2026-01-01', 0); db.close();
  const options = { source, stateRoot: path.join(root, 'new'), sourceAccount: 'first', account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } };
  const preview = await previewLegacyImport(options);
  assert.equal(preview.summary.total, 1); assert.equal(preview.summary.metricSnapshots, 0); assert.equal(preview.summary.ambiguousMetrics, 1);
  const applied = await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest });
  assert.equal(applied.importedMetrics, 0);
});

test('a target database symlink cannot rewrite the source database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.sqlite'), db = new DatabaseSync(source);
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,fingerprint TEXT,kind TEXT,account TEXT,title TEXT,body TEXT,topics_json TEXT,images_json TEXT,manifest_path TEXT,package_dir TEXT,state TEXT,created_at TEXT,updated_at TEXT)'); db.close();
  const stateRoot = path.join(root, 'target'); await fs.mkdir(stateRoot); await fs.symlink(source, path.join(stateRoot, 'xhs-ops.sqlite'));
  const options = { source, stateRoot, account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' } };
  const preview = await previewLegacyImport(options);
  await assert.rejects(applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }), /database symlinks/);
  const check = new DatabaseSync(source, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0); check.close();
});

test('modern task metadata, declarations and lineage survive SQLite migration', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-modern-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), targetRoot = path.join(root, 'target'); await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
  const original = path.join(sourceRoot, 'original.jpg'), upload = path.join(sourceRoot, 'upload.jpg');
  await fs.writeFile(original, 'original-bytes'); await fs.writeFile(upload, 'upload-bytes');
  const digest = file => createHash('sha256').update(file).digest('hex');
  const source = path.join(sourceRoot, 'xhs-ops.sqlite'), db = openDatabase(source);
  const lineage = [{ source: original, derived: upload, sourceSha256: digest(Buffer.from('original-bytes')), derivedSha256: digest(Buffer.from('upload-bytes')), purpose: 'exposure-adjustment', tool: 'fixture' }];
  db.prepare(`INSERT INTO tasks (id,fingerprint,kind,account,account_user_id,browser_profile,source_note_id,replaces_note_id,title,body,topics_json,images_json,video_json,cover_json,subtitle_json,manifest_path,package_dir,state,created_at,updated_at,media_lineage_json,declarations_json,series_id,episode,content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'xhs_abcdef0123456789abcdef', 'a'.repeat(64), 'publish', 'old', 'old-user', 'old-profile', null, null, 'Modern task', 'Body', '[]', JSON.stringify([{ path: upload, sha256: digest(Buffer.from('upload-bytes')), order: 1 }]), null, null, null, path.join(sourceRoot, 'post.json'), sourceRoot, 'draft', '2026-01-01', '2026-01-01', JSON.stringify(lineage), JSON.stringify({ original: true, aiGenerated: false }), 'travel-series', '7', 'travel-photo');
  db.close();
  const options = { source, stateRoot: targetRoot, account: { alias: 'demo', userId: 'old-user', profile: 'old-profile' }, pathMappings: [{ from: sourceRoot, to: sourceRoot }] };
  const preview = await previewLegacyImport(options); assert.equal(preview.operations[0].mediaLineage.length, 1); assert.deepEqual(preview.operations[0].declarations, { original: true, aiGenerated: false });
  const applied = await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }); assert.equal(applied.imported[0].state, 'draft');
  const target = openDatabase(path.join(targetRoot, 'xhs-ops.sqlite')); const row = target.prepare('SELECT media_lineage_json,declarations_json,series_id,episode,content_type FROM tasks').get(); target.close();
  assert.deepEqual(JSON.parse(row.media_lineage_json)[0].purpose, 'exposure-adjustment'); assert.deepEqual(JSON.parse(row.declarations_json), { original: true, aiGenerated: false }); assert.equal(row.series_id, 'travel-series'); assert.equal(row.episode, '7'); assert.equal(row.content_type, 'travel-photo');
});

test('a deduplicated modern package keeps declarations in dry-run and rechecks mapped lineage hashes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-migration-roundtrip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceMedia = path.join(root, 'old-media'), movedMedia = path.join(root, 'new-media'), targetRoot = path.join(root, 'state');
  await fs.mkdir(sourceMedia);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(sourceMedia, 'original.png'), png); await fs.writeFile(path.join(sourceMedia, 'upload.png'), png);
  await fs.writeFile(path.join(sourceMedia, 'post.json'), JSON.stringify({ account: 'demo', kind: 'publish', title: 'Mapped original', body: 'Synthetic caption', topics: [], images: ['upload.png'], declarations: { original: true, aiGenerated: false }, seriesId: 'travel-series', episode: 7, contentType: 'travel-photo', mediaLineage: [{ source: 'original.png', derived: 'upload.png', purpose: 'original' }] }));
  const content = await inspectPackage(sourceMedia), source = path.join(root, 'legacy.sqlite'), db = openDatabase(source), taskId = 'xhs_0123456789abcdefabcd';
  db.prepare(`INSERT INTO tasks (id,fingerprint,kind,account,account_user_id,browser_profile,title,body,topics_json,images_json,manifest_path,package_dir,state,created_at,updated_at,media_lineage_json,declarations_json,series_id,episode,content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    taskId, content.fingerprint, content.kind, 'demo', 'demo-user', 'demo-profile', content.title, content.body, JSON.stringify(content.topics), JSON.stringify(content.images), content.manifestPath, content.packageDir, 'draft', '2026-01-01', '2026-01-01', JSON.stringify(content.mediaLineage), JSON.stringify(content.declarations), content.seriesId, String(content.episode), content.contentType);
  db.close(); await fs.cp(sourceMedia, movedMedia, { recursive: true });
  const options = { source, stateRoot: targetRoot, account: { alias: 'demo', userId: 'demo-user', profile: 'demo-profile' }, pathMappings: [{ from: sourceMedia, to: movedMedia }] };
  const preview = await previewLegacyImport(options);
  await fs.appendFile(path.join(movedMedia, 'original.png'), 'changed');
  await assert.rejects(applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest }), /Mapped media/);
  await assert.rejects(fs.stat(targetRoot), { code: 'ENOENT' });
  await fs.writeFile(path.join(movedMedia, 'original.png'), png);
  await applyLegacyImport({ ...options, apply: true, expectedSourceDigest: preview.source.digest });
  await fs.writeFile(path.join(targetRoot, 'accounts.json'), JSON.stringify({ schemaVersion: 1, accounts: [{ alias: 'demo', userId: 'demo-user', profile: 'demo-profile' }] }));
  const env = { ...process.env, XHS_OPS_HOME: targetRoot, XHS_OPS_OWNER_HOME: path.join(root, 'owners') };
  const call = async args => JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout);
  const duplicate = await call(['ingest', movedMedia]); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.taskId, taskId);
  await call(['approve', taskId, '--authorization', 'Synthetic migration roundtrip']);
  const dryRun = await call(['run', taskId, '--dry-run']); assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.argv[dryRun.argv.indexOf('--original') + 1], 'true'); assert.equal(dryRun.argv[dryRun.argv.indexOf('--ai-declaration') + 1], 'false');
  const saved = openDatabase(path.join(targetRoot, 'xhs-ops.sqlite'));
  const task = saved.prepare('SELECT media_lineage_json,declarations_json,series_id,episode,content_type FROM tasks WHERE id=?').get(taskId); saved.close();
  assert.equal(JSON.parse(task.media_lineage_json)[0].source, path.join(movedMedia, 'original.png')); assert.equal(JSON.parse(task.media_lineage_json)[0].derived, path.join(movedMedia, 'upload.png'));
  assert.deepEqual(JSON.parse(task.declarations_json), { original: true, aiGenerated: false }); assert.equal(task.series_id, 'travel-series'); assert.equal(task.episode, '7'); assert.equal(task.content_type, 'travel-photo');
});
