import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_VERSION = '1.0.26';
const EXTENSION_URL = 'https://github.com/jackwener/OpenCLI/releases/download/v2.0.2/opencli-extension-v1.0.26.zip';
const EXTENSION_SHA256 = '2b2eff46fe4a21a0b02516e743005066e6317b48f15455c1c7b07f69ad7af211';
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

function paths(options) {
  const stateRoot = path.resolve(options.stateRoot || process.env.XHS_OPS_HOME || path.join(os.homedir(), '.local/share/rednote-steward'));
  const installRoot = path.resolve(options.installRoot || process.env.XHS_OPS_INSTALL_ROOT || path.join(os.homedir(), '.local/share/rednote-steward/app'));
  return {
    stateRoot,
    installRoot,
    sourceRoot: path.resolve(options.sourceRoot || PACKAGE_ROOT),
    codexRoot: path.resolve(options.codexRoot || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    binDir: path.resolve(options.binDir || process.env.XHS_OPS_BIN_DIR || path.join(os.homedir(), '.local/bin')),
    receipt: path.join(stateRoot, 'installation.json'),
    extension: path.join(installRoot, 'browser-bridge', EXTENSION_VERSION),
  };
}

async function managedFile(source, target, receipt, stateRoot) {
  const content = await fs.readFile(source);
  const expectedHash = digest(content);
  const previous = receipt.files.find((entry) => entry.path === target);
  let current = null;
  try { current = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current && digest(current) === expectedHash) return { path: target, status: 'current' };

  let backup = previous?.backup || null;
  if (current && (!previous || digest(current) !== previous.sha256)) {
    const backupPath = path.join(stateRoot, 'installation-backups', `${digest(target).slice(0, 12)}-${Date.now()}`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(target, backupPath);
    // Restore the latest user-owned content on uninstall, including edits made
    // after an earlier managed installation.
    backup = backupPath;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  const next = { path: target, sha256: expectedHash, backup };
  receipt.files = receipt.files.filter((entry) => entry.path !== target);
  receipt.files.push(next);
  return { path: target, status: current ? 'updated' : 'installed', ...(backup ? { backup } : {}) };
}

async function codexGet(command, codexRoot) {
  try {
    const { stdout } = await exec(command, ['mcp', 'get', 'rednote-steward', '--json'], {
      env: { ...process.env, CODEX_HOME: codexRoot }, timeout: 15_000,
    });
    return { available: true, config: JSON.parse(stdout) };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, config: null };
    const detail = `${error.stderr || ''}${error.stdout || ''}`;
    if (/CODEX_HOME/.test(detail) && /does not exist/.test(detail)) return { available: true, config: null, needsDirectory: true };
    if (/not found|no mcp server|does not exist|unknown server/i.test(detail)) return { available: true, config: null };
    throw new Error(`Could not read Codex MCP configuration: ${detail.trim() || error.message}`);
  }
}

function sameCommand(config, command, args = [], env = {}) {
  const transport = config?.transport || config;
  const actualEnv = transport?.env || {};
  return transport?.command === command && JSON.stringify(transport.args || []) === JSON.stringify(args) &&
    Object.keys(actualEnv).length === Object.keys(env).length &&
    Object.entries(env).every(([key, value]) => actualEnv[key] === value);
}

async function registerMcp(p, options, receipt) {
  const wrapper = path.join(p.binDir, 'rednote-steward-mcp');
  const command = await exists(wrapper) ? wrapper : process.execPath;
  const args = command === wrapper ? [] : [path.join(p.sourceRoot, 'src/mcp.mjs')];
  const env = { XHS_OPS_HOME: p.stateRoot };
  const config = { mcpServers: { 'rednote-steward': { command, args, env } } };
  const codexCommand = options.codexCommand || 'codex';
  const existing = await codexGet(codexCommand, p.codexRoot);
  if (!existing.available) return { status: 'manual', config, reason: 'Codex CLI is unavailable; use this configuration in an MCP client.' };
  if (existing.needsDirectory) await fs.mkdir(p.codexRoot, { recursive: true, mode: 0o700 });
  if (existing.config && sameCommand(existing.config, command, args, env)) {
    return { status: 'current', config };
  }
  if (existing.config && !sameCommand(existing.config, receipt.mcp?.command, receipt.mcp?.args, receipt.mcp?.env)) {
    return { status: 'conflict', config, reason: 'A different rednote-steward MCP entry exists; its configuration was preserved.' };
  }
  await exec(codexCommand, ['mcp', 'add', '--env', `XHS_OPS_HOME=${p.stateRoot}`, 'rednote-steward', '--', command, ...args], {
    env: { ...process.env, CODEX_HOME: p.codexRoot }, timeout: 15_000,
  });
  const verified = await codexGet(codexCommand, p.codexRoot);
  if (!sameCommand(verified.config, command, args, env)) throw new Error('Codex MCP registration readback did not match.');
  receipt.mcp = { command, args, env, codexRoot: p.codexRoot };
  return { status: 'installed', config };
}

async function prepareExtension(p) {
  const manifestPath = path.join(p.extension, 'manifest.json');
  if ((await readJson(manifestPath))?.version === EXTENSION_VERSION) {
    return { status: 'ready', path: p.extension, version: EXTENSION_VERSION };
  }
  const response = await fetch(EXTENSION_URL, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Browser Bridge download returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (digest(archive) !== EXTENSION_SHA256) throw new Error('Browser Bridge archive checksum did not match the pinned release.');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-browser-'));
  try {
    const zip = path.join(stage, 'extension.zip');
    await fs.writeFile(zip, archive);
    const unpacked = path.join(stage, 'unpacked');
    await exec('unzip', ['-q', zip, '-d', unpacked]);
    const candidates = [unpacked];
    for (const entry of await fs.readdir(unpacked, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(unpacked, entry.name));
    }
    let extensionRoot = null;
    for (const candidate of candidates) {
      if ((await readJson(path.join(candidate, 'manifest.json')))?.version === EXTENSION_VERSION) extensionRoot = candidate;
    }
    if (!extensionRoot) throw new Error('Browser Bridge archive has no matching manifest.');
    await fs.mkdir(path.dirname(p.extension), { recursive: true });
    // Only the versioned extension folder belongs to this operation.
    if (await exists(p.extension)) await fs.rename(p.extension, `${p.extension}.backup-${Date.now()}`);
    await fs.cp(extensionRoot, p.extension, { recursive: true });
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
  return { status: 'ready', path: p.extension, version: EXTENSION_VERSION };
}

async function uninstall(p, options, receipt) {
  const changes = [];
  const kept = [];
  for (const entry of receipt.files) {
    if (!(await exists(entry.path))) continue;
    const current = digest(await fs.readFile(entry.path));
    if (current !== entry.sha256) { kept.push({ path: entry.path, reason: 'modified since installation' }); continue; }
    if (entry.backup && await exists(entry.backup)) {
      await fs.copyFile(entry.backup, entry.path);
      changes.push({ path: entry.path, status: 'restored' });
    } else {
      await fs.unlink(entry.path);
      changes.push({ path: entry.path, status: 'removed' });
    }
  }
  if (receipt.mcp) {
    const existing = await codexGet(options.codexCommand || 'codex', receipt.mcp.codexRoot || p.codexRoot);
    if (existing.available && sameCommand(existing.config, receipt.mcp.command, receipt.mcp.args, receipt.mcp.env)) {
      await exec(options.codexCommand || 'codex', ['mcp', 'remove', 'rednote-steward'], {
        env: { ...process.env, CODEX_HOME: receipt.mcp.codexRoot || p.codexRoot }, timeout: 15_000,
      });
      changes.push({ name: 'rednote-steward MCP', status: 'removed' });
    } else if (existing.config) kept.push({ name: 'rednote-steward MCP', reason: 'configuration differs from installation' });
  }
  await saveJson(p.receipt, { ...receipt, files: [], mcp: null, uninstalledAt: new Date().toISOString() });
  return { ok: true, changes, kept, dataPreserved: p.stateRoot };
}

/** Idempotent local integration setup. This never reads account cookies or posts. */
export async function setup(options = {}) {
  const p = paths(options);
  const receipt = await readJson(p.receipt, { schemaVersion: 1, product: 'rednote-steward', files: [], mcp: null });
  if (receipt.product !== 'rednote-steward' || !Array.isArray(receipt.files)) throw new Error('Installation record does not belong to RedNote Steward.');
  if (options.status) return { ok: true, ...p, installed: receipt.files, mcp: receipt.mcp, extensionReady: await exists(path.join(p.extension, 'manifest.json')) };
  if (options.uninstall) return uninstall(p, options, receipt);

  const checks = [];
  for (const relative of ['node_modules/@jackwener/opencli/package.json', 'src/opencli-runner.mjs', 'adapters/opencli']) {
    checks.push({ name: relative, ok: await exists(path.join(p.sourceRoot, relative)) });
  }
  const output = { ok: checks.every((check) => check.ok), checks, paths: p, integrations: {} };
  const skipIntegrations = options['skip-integrations'] || options.skipIntegrations;
  if (!skipIntegrations && options.skill) {
    output.integrations.skill = await managedFile(
      path.join(p.sourceRoot, 'skills/rednote-steward/SKILL.md'),
      path.join(p.codexRoot, 'skills/rednote-steward/SKILL.md'), receipt, p.stateRoot,
    );
    await saveJson(p.receipt, receipt);
  }
  if (!skipIntegrations && options.mcp) {
    output.integrations.mcp = await registerMcp(p, options, receipt);
    if (output.integrations.mcp.status === 'conflict') output.ok = false;
    await saveJson(p.receipt, receipt);
  }
  if ((options['browser-extension'] || options.browserExtension) && !(options['skip-browser-setup'] || options.skipBrowserSetup)) {
    try { output.integrations.browser = await prepareExtension(p); }
    catch (error) {
      output.integrations.browser = { status: 'needs_setup', error: error.message, download: EXTENSION_URL };
      output.ok = false;
    }
  }
  output.next = [
    'In Chrome, enable the OpenCLI Browser Bridge. For a new installation, open chrome://extensions and load the unpacked folder reported above.',
    'Sign in to Xiaohongshu in that Chrome profile, then bind its stable user ID and profile with xhs-ops account add.',
    'Run xhs-ops doctor to check the installed toolchain and bound account.',
  ];
  return output;
}
