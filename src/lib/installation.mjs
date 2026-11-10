import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { publicContentDigest, readJson } from './build.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const identity = {
  surface_kind: 'rednote_installation_status.v1',
  package_id: 'rednote-steward',
  display_name: 'RedNote Steward',
  description: 'Prepare, review and manage Xiaohongshu publications through one local CLI and MCP service.',
  installation_owner: 'rednote-steward-native-installer',
};

/** Local installation facts only: no browser, account, queue or credential reads. */
export async function installationStatus({ installRoot = process.env.XHS_OPS_INSTALL_ROOT
  || path.join(os.homedir(), '.local/share/rednote-steward/app') } = {}) {
  const root = path.resolve(installRoot);
  const result = { ...identity, installed: null, installed_version: null, source_revision: null,
    content_digest: null, status: 'attention', reason: null, revision: null,
    update_status: 'not_checked', user_data_preserved_on_uninstall: true };
  try {
    const receipt = await readJson(path.join(root, 'install.json'));
    if (!receipt) return { ...result, installed: false, status: 'not_installed', reason: 'installation_receipt_absent' };
    if (receipt.product !== identity.package_id || receipt.root !== root) {
      return { ...result, reason: 'installation_owner_mismatch' };
    }
    const selected = await fs.realpath(path.join(root, 'current')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!selected && receipt.uninstalledAt) {
      return { ...result, installed: false, status: 'not_installed', reason: 'uninstalled' };
    }
    const realRoot = await fs.realpath(root);
    if (!selected || !selected.startsWith(`${realRoot}${path.sep}releases${path.sep}`)
      || typeof receipt.current !== 'string' || await fs.realpath(receipt.current) !== selected) {
      return { ...result, reason: 'installation_selection_mismatch' };
    }
    const [pkg, location, manifest] = await Promise.all([
      readJson(path.join(selected, 'package.json')),
      readJson(path.join(selected, '.install-location.json')),
      readJson(path.join(selected, 'release-manifest.json')),
    ]);
    if (pkg?.name !== identity.package_id || pkg.version !== receipt.version
      || location?.product !== identity.package_id || path.resolve(location.root || '') !== root
      || receipt.uninstalledAt) return { ...result, reason: 'installation_identity_mismatch' };
    const content = await publicContentDigest(selected);
    const observed = { ...result, installed: true, installed_version: pkg.version,
      source_revision: typeof receipt.sourceRevision === 'string' ? receipt.sourceRevision : null,
      content_digest: content.digest,
      revision: hash(JSON.stringify([receipt, selected, content.digest])) };
    if (content.digest !== receipt.contentDigest || manifest && (manifest.product !== identity.package_id
      || manifest.version !== pkg.version || manifest.content?.digest !== content.digest
      || manifest.sourceRevision !== receipt.sourceRevision)) {
      return { ...observed, reason: 'installation_content_changed' };
    }
    if (!Array.isArray(receipt.wrappers) || receipt.wrappers.length !== 2) {
      return { ...observed, reason: 'installation_commands_missing' };
    }
    for (const wrapper of receipt.wrappers) {
      if (typeof wrapper.path !== 'string' || typeof wrapper.sha256 !== 'string') {
        return { ...observed, reason: 'installation_commands_invalid' };
      }
      const bytes = await fs.readFile(wrapper.path).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!bytes || hash(bytes) !== `sha256:${wrapper.sha256}`) {
        return { ...observed, reason: 'installation_commands_changed' };
      }
    }
    return { ...observed, status: 'ready', reason: null };
  } catch {
    return { ...result, reason: 'installation_unreadable' };
  }
}
