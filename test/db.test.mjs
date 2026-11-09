import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/lib/db.mjs';
import { claimNextTask, rowToTask, setTaskPhase, recordWorkerLaunch } from '../src/lib/db.mjs';

test('initialization waits for a competing writer before enabling WAL', { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rednote-wal-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('CREATE TABLE seed (value TEXT); BEGIN IMMEDIATE;');
  let released = false, releaseTimer;
  const childScript = `
    import { openDatabase } from ${JSON.stringify(new URL('../src/lib/db.mjs', import.meta.url).href)};
    process.stdout.write('opening\\n');
    const db = openDatabase(process.argv[1]);
    process.stdout.write(db.prepare('PRAGMA journal_mode').get().journal_mode + '\\n');
    db.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    clearTimeout(releaseTimer);
    child.kill();
    if (!released) blocker.exec('ROLLBACK');
    blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!releaseTimer && stdout.includes('opening')) releaseTimer = setTimeout(() => {
      blocker.exec('COMMIT');
      released = true;
    }, 100);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(released, true);
  assert.match(stdout, /\nwal\n/);
});

test('migrates an existing metrics table without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-db-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE metrics (
      note_id TEXT PRIMARY KEY,
      title TEXT,
      published_at TEXT,
      views INTEGER,
      likes INTEGER,
      collects INTEGER,
      comments INTEGER,
      url TEXT,
      captured_at TEXT NOT NULL
    );
    INSERT INTO metrics (note_id, title, views, captured_at)
    VALUES ('abc', '旧记录', 10, '2026-10-24T00:00:00Z');
  `);
  legacy.close();

  const migrated = openDatabase(dbPath);
  const columns = new Set(
    migrated.prepare('PRAGMA table_info(metrics)').all().map((column) => column.name),
  );
  assert.equal(columns.has('shares'), true);
  assert.equal(columns.has('top_interest_pct'), true);
  assert.equal(
    migrated.prepare('SELECT views FROM metrics WHERE note_id = ?').get('abc').views,
    10,
  );
  migrated.close();
});

test('automatic claim skips a blocked account and records attempt phase and worker launch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-queue-'));
  const db = openDatabase(path.join(dir, 'state.sqlite'));
  const insert = db.prepare(`INSERT INTO tasks (id,fingerprint,kind,account,account_user_id,browser_profile,title,body,topics_json,images_json,manifest_path,package_dir,state,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const at = new Date().toISOString();
  const base = ['xhs_a','a','publish','a','uid-a','profile-a','A','body','[]','[]','/tmp/post.json','/tmp','queued',at,at,at];
  insert.run(...base);
  insert.run('xhs_block','b','publish','a','uid-a','profile-a','Blocked','body','[]','[]','/tmp/post.json','/tmp','needs_review',at,at,at);
  insert.run('xhs_b','c','publish','b','uid-b','profile-b','B','body','[]','[]','/tmp/post.json','/tmp','queued',at,at,at);
  const claimed = claimNextTask(db);
  assert.equal(claimed.id, 'xhs_b');
  assert.equal(claimed.phase, 'claimed');
  assert.match(claimed.attempt_id, /^attempt_/);
  setTaskPhase(db, claimed.id, 'prepared', { persistedDraftVerified: false });
  recordWorkerLaunch(db, claimed.id, { status: 'started', pid: process.pid, log: 'synthetic' });
  const row = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(claimed.id));
  assert.equal(row.phase, 'prepared');
  assert.equal(row.worker_launch.status, 'started');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('metric observation migration keeps historical snapshots append-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-metrics-'));
  const db = openDatabase(path.join(dir, 'state.sqlite'));
  db.prepare('INSERT INTO metrics (note_id,title,views,captured_at) VALUES (?,?,?,?)').run('000000000000000000000001','Post',1,'2026-01-01T00:00:00Z');
  db.exec('PRAGMA user_version=1');
  db.close();
  const reopened = openDatabase(path.join(dir, 'state.sqlite'));
  const captured = reopened.prepare('SELECT COUNT(*) AS count FROM metric_observations WHERE note_id=?').get('000000000000000000000001').count;
  assert.equal(captured, 1);
  reopened.prepare(`INSERT INTO metric_observations (note_id,title,views,captured_at,source) VALUES (?,?,?,?,?)`).run('000000000000000000000001','Post',2,'2026-01-02T00:00:00Z','test');
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM metric_observations WHERE note_id=?').get('000000000000000000000001').count, 2);
  reopened.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('a future database schema is rejected before changing its tables or version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-future-'));
  const file = path.join(dir,'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE future_only (value TEXT); PRAGMA user_version=99');
  db.close();
  assert.throws(() => openDatabase(file), /schema 99 is newer/);
  const verify = new DatabaseSync(file, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='tasks'").get().count, 0);
  assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 99);
  verify.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('competing schema migrations import the legacy latest observation exactly once', { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-migrate-race-'));
  const file = path.join(dir,'state.sqlite');
  const blocker = openDatabase(file);
  blocker.prepare('INSERT INTO metrics (note_id,title,views,captured_at) VALUES (?,?,?,?)').run('000000000000000000000001','Legacy',1,'2026-01-01T00:00:00Z');
  blocker.exec('PRAGMA user_version=1; BEGIN IMMEDIATE');
  let released = false;
  t.after(() => { if (!released) blocker.exec('ROLLBACK'); blocker.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const script = `import {openDatabase} from ${JSON.stringify(new URL('../src/lib/db.mjs',import.meta.url).href)};
    process.stdout.write('ready\\n'); const db=openDatabase(process.argv[1]); db.close();`;
  const children = [0,1].map(() => spawn(process.execPath,['--input-type=module','--eval',script,file],{stdio:['ignore','pipe','pipe']}));
  const ready = children.map(child => new Promise(resolve => child.stdout.once('data',resolve)));
  const results = children.map(child => new Promise((resolve,reject) => {
    let stderr=''; child.stderr.on('data',value=>stderr+=value); child.once('error',reject); child.once('close',code=>resolve({code,stderr}));
  }));
  await Promise.all(ready);
  await new Promise(resolve => setTimeout(resolve,80));
  blocker.exec('COMMIT'); released=true;
  for (const result of await Promise.all(results)) assert.equal(result.code,0,result.stderr);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM metric_observations WHERE source='legacy-latest'").get().count,1);
});
