import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export function ownerRoot() {
  return path.resolve(process.env.XHS_OPS_OWNER_HOME || path.join(os.homedir(), '.local', 'share', 'rednote-steward', 'owners'));
}
function canonicalHome(value) {
  const absolute = path.resolve(value || process.env.XHS_OPS_HOME || path.join(os.homedir(), '.local', 'share', 'rednote-steward'));
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalHome(parent), path.basename(absolute));
  }
}
function identity(input, options = {}) {
  const accountUserId = input.accountUserId || input.userId;
  const browserProfile = input.browserProfile || input.profile;
  if (!accountUserId || !browserProfile) throw new Error('A stable account ID and browser profile are required for state ownership');
  return { accountUserId: String(accountUserId), browserProfile: String(browserProfile),
    home: canonicalHome(options.home || input.home), alias: String(input.alias || '') };
}
function failure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}
function registry({ readOnly = false } = {}) {
  const file = path.join(ownerRoot(), 'registry.sqlite');
  if (readOnly && !fs.existsSync(file)) return null;
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { readOnly, timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_owners (
      account_user_id TEXT PRIMARY KEY, browser_profile TEXT NOT NULL UNIQUE,
      home TEXT NOT NULL, alias TEXT NOT NULL, registered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS write_leases (
      token TEXT PRIMARY KEY, account_user_id TEXT NOT NULL, browser_profile TEXT NOT NULL,
      home TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT,
      pid INTEGER NOT NULL, process_start TEXT, state TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    fs.chmodSync(file, 0o600);
  }
  return db;
}
function mutate(work) {
  const db = registry();
  try {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(db); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
function matching(db, table, owner) {
  return db.prepare(`SELECT * FROM ${table} WHERE account_user_id = ? OR browser_profile = ?`)
    .all(owner.accountUserId, owner.browserProfile);
}
function register(db, owner) {
  const previous = matching(db, 'account_owners', owner);
  const conflicting = previous.find(row => row.home !== owner.home || row.account_user_id !== owner.accountUserId || row.browser_profile !== owner.browserProfile);
  if (conflicting) throw failure('state_owner_conflict',
    `This account or browser profile belongs to another state owner at ${conflicting.home}; inspect it before transferring ownership`, { owner: conflicting });
  const registeredAt = previous[0]?.registered_at || new Date().toISOString();
  db.prepare(`INSERT INTO account_owners (account_user_id,browser_profile,home,alias,registered_at)
    VALUES (?,?,?,?,?) ON CONFLICT(account_user_id) DO UPDATE SET alias=excluded.alias`)
    .run(owner.accountUserId, owner.browserProfile, owner.home, owner.alias || previous[0]?.alias || '', registeredAt);
  return { ...owner, registeredAt };
}
function processStart(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
function activeLease(row) {
  if (row.state !== 'active') return false;
  try { process.kill(Number(row.pid), 0); }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
  const start = processStart(row.pid);
  return !row.process_start || !start || start === row.process_start;
}

/** Register a single same-machine owner for either account-ID or profile conflicts. */
export function registerAccountOwner(account, options = {}) {
  const owner = identity(account, options);
  return mutate(db => {
    const result = register(db, owner);
    options.commit?.(result);
    return result;
  });
}

/** This inspection creates neither the registry nor a task database. */
export function inspectAccountOwner(account, options = {}) {
  const owner = identity(account, options);
  const db = registry({ readOnly: true });
  if (!db) return { state: 'unregistered', home: owner.home, owners: [], leases: [], conflicts: [] };
  try {
    const owners = matching(db, 'account_owners', owner);
    const leases = matching(db, 'write_leases', owner).map(row => {
      const active = activeLease(row);
      return { ...row, process_active: active, observed_state: row.state === 'active' && !active ? 'stale_unknown' : row.state };
    });
    const conflicts = owners.filter(row => row.home !== owner.home || row.account_user_id !== owner.accountUserId || row.browser_profile !== owner.browserProfile);
    return { state: conflicts.length ? 'conflict' : owners.length ? 'owned' : 'unregistered', home: owner.home, owners, leases, conflicts };
  } finally { db.close(); }
}

/** A crashed process never frees a lease automatically; platform reconciliation does. */
export function acquireAccountWrite(input) {
  const owner = identity(input);
  if (!input.taskId) throw new Error('A task ID is required for an account write lease');
  const lease = mutate(db => {
    register(db, owner);
    const previous = matching(db, 'write_leases', owner)[0];
    if (previous) throw failure('account_write_unresolved',
      `Account is blocked by ${previous.task_id} in ${previous.home}; reconcile that attempt before another write`,
      { lease: { ...previous, process_active: activeLease(previous) } });
    const timestamp = new Date().toISOString();
    const row = { token: randomUUID(), ...owner, taskId: String(input.taskId), attemptId: input.attemptId == null ? null : String(input.attemptId),
      pid: process.pid, processStart: processStart(process.pid), startedAt: timestamp };
    db.prepare(`INSERT INTO write_leases (token,account_user_id,browser_profile,home,task_id,attempt_id,pid,process_start,state,started_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'active',?,?)`).run(row.token, owner.accountUserId, owner.browserProfile, owner.home, row.taskId, row.attemptId,
      row.pid, row.processStart, timestamp, timestamp);
    return row;
  });
  return { ...lease, release({ unresolved = false } = {}) {
    return mutate(db => {
      const row = db.prepare('SELECT * FROM write_leases WHERE token=?').get(lease.token);
      if (!row) return { released: true, unchanged: true };
      if (row.home !== lease.home || row.task_id !== lease.taskId) throw new Error('Account write lease identity changed');
      if (unresolved) db.prepare("UPDATE write_leases SET state='unresolved',updated_at=? WHERE token=?").run(new Date().toISOString(), lease.token);
      else db.prepare('DELETE FROM write_leases WHERE token=?').run(lease.token);
      return { released: !unresolved, unresolved };
    });
  } };
}

/** Call only after the Controller has resolved this same task against the platform. */
export function resolveAccountWrite(input) {
  const owner = identity(input);
  if (!input.taskId || !String(input.reason || '').trim()) throw new Error('Resolved task ID and reconciliation reason are required');
  return mutate(db => {
    const leases = matching(db, 'write_leases', owner);
    if (leases.some(row => row.home !== owner.home || row.task_id !== String(input.taskId))) throw failure('account_write_unresolved', 'A different task owns the account write lease');
    if (leases.some(row => activeLease(row))) throw failure('account_write_active', 'The account write process is still active; wait before resolving its lease');
    const count = db.prepare('DELETE FROM write_leases WHERE home=? AND task_id=? AND (account_user_id=? OR browser_profile=?)')
      .run(owner.home, String(input.taskId), owner.accountUserId, owner.browserProfile).changes;
    return { released: true, leases: Number(count), reason: String(input.reason).trim() };
  });
}

function unresolvedInHome(home, owner, alias) {
  const file = path.join(home, 'xhs-ops.sqlite');
  if (!fs.existsSync(file)) throw failure('owner_source_unavailable', 'The previous owner database is unavailable; restore it before transferring ownership');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name));
    if (!columns.has('state')) throw failure('owner_source_unavailable', 'The previous owner database cannot be inspected');
    const predicates = [], values = [];
    for (const [name, value] of [['account_user_id', owner.accountUserId], ['browser_profile', owner.browserProfile], ['account', alias]]) {
      if (columns.has(name) && value) { predicates.push(`${name}=?`); values.push(value); }
    }
    if (!predicates.length) throw failure('owner_source_unavailable', 'The previous owner has no verifiable account identity');
    return db.prepare(`SELECT id,state FROM tasks WHERE state IN ('running','submitted','needs_review') AND (${predicates.join(' OR ')})`).all(...values);
  } finally { db.close(); }
}

/** Transfer only a quiescent, readable previous owner. This does not clear unknown submissions. */
export function transferAccountOwner(account, { home, fromHome, reason, commit } = {}) {
  const owner = identity(account, { home });
  if (!fromHome || !String(reason || '').trim()) throw new Error('An exact --from-home and a transfer reason are required');
  const source = canonicalHome(fromHome);
  if (source === owner.home) throw new Error('The previous and new state homes must differ');
  return mutate(db => {
    const registrations = matching(db, 'account_owners', owner);
    if (!registrations.length || registrations.some(row => row.home !== source)) throw failure('state_owner_conflict', 'The specified previous home does not own this account or profile');
    if (matching(db, 'write_leases', owner).length) throw failure('account_write_unresolved', 'An active or unresolved write lease must be reconciled before ownership transfer');
    for (const registration of registrations) {
      const unresolved = unresolvedInHome(source, owner, registration.alias);
      if (unresolved.length) throw failure('account_write_unresolved', 'The previous state has unresolved tasks; reconcile them there before ownership transfer', { tasks: unresolved });
    }
    db.prepare('DELETE FROM account_owners WHERE account_user_id=? OR browser_profile=?').run(owner.accountUserId, owner.browserProfile);
    const result = { ...register(db, owner), previousHome: source, reason: String(reason).trim() };
    commit?.(result);
    return result;
  });
}
