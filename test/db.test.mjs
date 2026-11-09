import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/lib/db.mjs';

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
