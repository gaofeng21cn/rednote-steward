import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/lib/db.mjs';

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

test('concurrent initialization shares one migrated database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-ops-db-concurrent-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const opened = await Promise.all(
    Array.from({ length: 6 }, async () => openDatabase(dbPath)),
  );
  for (const db of opened) {
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 30000);
    db.close();
  }
});
