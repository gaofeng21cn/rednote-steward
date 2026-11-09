import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from './db.mjs';
import { registerAccountOwner, transferAccountOwner } from './owner.mjs';

export function stateRoot() {
  return path.resolve(process.env.XHS_OPS_HOME || path.join(os.homedir(), '.local', 'share', 'rednote-steward'));
}
export function privateDirectory(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
export function accountFile() { return path.join(stateRoot(), 'accounts.json'); }
export function listAccounts() {
  try {
    const config = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
    if (config.schemaVersion !== 1 || !Array.isArray(config.accounts)) throw new Error('Invalid accounts.json schema');
    return config.accounts;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
export function getAccount(alias) {
  const account = listAccounts().find(item => item.alias === alias);
  if (!account) throw new Error(`Account ${alias || '(missing)'} is not bound; use xhs-ops account add`);
  return account;
}
export function validateAccountBinding({ alias, userId, profile, name = '' } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias ?? '')) throw new Error('Account alias must use letters, numbers, _ or -');
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(userId ?? '')) throw new Error('A stable platform user ID is required');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profile ?? '')) throw new Error('A browser profile alias is required');
  return { alias, userId, profile, name: String(name) };
}
function checkBinding(accounts, account) {
  const existing = accounts.find(item => item.alias === account.alias);
  if (existing && (existing.userId !== account.userId || existing.profile !== account.profile)) {
    throw new Error('An existing alias has a different binding; create a separate workspace for a different account/profile');
  }
  if (accounts.some(item => item.alias !== account.alias && (item.userId === account.userId || item.profile === account.profile))) {
    throw new Error('This user ID or browser profile is already bound to another alias');
  }
}
function writeBinding(account, ownerMutation) {
  privateDirectory(stateRoot());
  const database = openDatabase(path.join(stateRoot(), 'xhs-ops.sqlite'));
  try { return transaction(database, () => {
    const accounts = listAccounts();
    checkBinding(accounts, account);
    const updated = [...accounts.filter(item => item.alias !== account.alias), account];
    const temp = `${accountFile()}.${randomUUID()}.tmp`;
    const original = fs.existsSync(accountFile()) ? fs.readFileSync(accountFile()) : null;
    let renamed = false;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, accounts: updated }, null, 2)}\n`, { mode: 0o600 });
      const owner = ownerMutation(() => { fs.renameSync(temp, accountFile()); renamed = true; });
      return { account, owner };
    } catch (error) {
      // Roll back a successful file rename if the registry commit failed afterwards.
      if (renamed) {
        if (original) fs.writeFileSync(accountFile(), original, { mode: 0o600 });
        else fs.rmSync(accountFile(), { force: true });
      }
      throw error;
    } finally { fs.rmSync(temp, { force: true }); }
  }); } finally { database.close(); }
}
export function addAccount(input) {
  const account = validateAccountBinding(input);
  return writeBinding(account, commit => registerAccountOwner(account, { home: stateRoot(), commit })).account;
}
export function transferAccountBinding(input, { fromHome, reason } = {}) {
  const account = validateAccountBinding(input);
  if (!fromHome || !String(reason || '').trim()) throw new Error('An exact --from-home and a transfer reason are required');
  return writeBinding(account, commit => transferAccountOwner(account, { home: stateRoot(), fromHome, reason, commit }));
}
