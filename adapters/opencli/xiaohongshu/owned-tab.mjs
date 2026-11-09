import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.resolve('@jackwener/opencli/registry')));
const daemonClientUrl = pathToFileURL(path.join(runtimeDirectory, 'browser', 'daemon-client.js')).href;
let sendCommandPromise;

function daemonSendCommand() {
  sendCommandPromise ??= import(daemonClientUrl).then(module => module.sendCommand);
  return sendCommandPromise;
}

/**
 * Remove the exact Xiaohongshu adapter-owned tab instead of navigating it to
 * about:blank. Before removal, replace its document in place so editor
 * listeners cannot hold the tab open with a beforeunload prompt. Browser
 * Bridge 1.0.26 then removes the known adapter tab by its owned lease identity.
 */
export async function closeOwnedTab(page, { sendCommand, clearDocument } = {}) {
  if (typeof page?.session !== 'string' || !page.session.trim()) return { skipped: 'no-adapter-session' };
  if (page.surface !== 'adapter') return { skipped: 'not-adapter-surface' };
  const prefix = 'site:xiaohongshu:';
  if (!page.session.startsWith(prefix) || !page.session.slice(prefix.length).trim()) {
    return { skipped: 'not-xiaohongshu-adapter-session' };
  }
  let preparedForClose = false;
  if (typeof (clearDocument ?? page.evaluate) === 'function') {
    try {
      // document.open/close replaces the current document without navigation,
      // which removes unsaved-editor event listeners before the tab is closed.
      await (clearDocument ?? (source => page.evaluate(source)))(`(() => {
        window.onbeforeunload = null;
        document.open();
        document.write('');
        document.close();
        return true;
      })()`);
      preparedForClose = true;
    } catch {
      // Closing the owned tab can still succeed when the document is already
      // gone or no longer executable. Keep cleanup diagnostics secondary.
    }
  }
  const send = sendCommand ?? await daemonSendCommand();
  const result = await send('close-owned-tab', {
    session: page.session,
    surface: 'adapter',
    ...(page.contextId ? { contextId: page.contextId } : {}),
    ...(page.windowMode ? { windowMode: page.windowMode } : {}),
  });
  return { ...result, preparedForClose };
}

const explicitlyTrue = value => value === true || value === 'true';

// OpenCLI consumes common options before invoking the adapter. Carry only its
// explicit retention intent across that boundary; reset inherited signals.
export function configureOwnedTabRetention(argv, command, env = process.env) {
  const modes = new Map(['--profile', '--window', '--site-session', '--keep-tab', '-f', '--format', '--trace']
    .map(name => [name, 'required']));
  for (const arg of command?.args || []) {
    if (!arg.positional) modes.set(`--${arg.name}`, arg.required || arg.valueRequired ? 'required' : 'optional');
  }
  let keepTab = false, persistent = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const split = token.indexOf('=');
    const key = split < 0 ? token : token.slice(0, split);
    if (!modes.has(key)) continue;
    const mode = modes.get(key);
    const value = split >= 0 ? token.slice(split + 1)
      : mode === 'required' || (argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[++i] : undefined;
    if (key === '--keep-tab') keepTab = value === 'true';
    if (key === '--site-session') persistent = value === 'persistent';
  }
  env.REDNOTE_STEWARD_KEEP_TAB = keepTab || persistent ? '1' : '0';
}

/**
 * Close a one-shot adapter's owned tab on success or failure. Prepared
 * composers and explicitly retained/persistent sessions remain available.
 * Cleanup and its diagnostics never change the business result.
 */
export function withOwnedTabCleanup(fn, { close = closeOwnedTab, report = console.error, env = process.env } = {}) {
  return async (...args) => {
    const [page, kwargs] = args;
    const keep = explicitlyTrue(kwargs?.['prepare-only']) || explicitlyTrue(kwargs?.prepareOnly) ||
      explicitlyTrue(kwargs?.['keep-tab']) || explicitlyTrue(kwargs?.keepTab) ||
      page?.siteSession === 'persistent' || env.REDNOTE_STEWARD_KEEP_TAB === '1';
    try {
      return await fn(...args);
    } finally {
      if (!keep) {
        try {
          await close(page);
        } catch (cleanupError) {
          try { report('OpenCLI owned-tab cleanup failed', cleanupError); }
          catch { /* Diagnostics must preserve the original outcome too. */ }
        }
      }
    }
  };
}
