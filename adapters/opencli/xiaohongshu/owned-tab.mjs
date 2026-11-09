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
 * Remove the adapter-owned tab instead of navigating it to about:blank.
 *
 * OpenCLI 1.8.5 releases a one-shot lease by navigating the last owned tab to
 * about:blank. Unsaved creator editors block that navigation with beforeunload,
 * leaving both the confirmation prompt and the tab behind. Browser Bridge
 * 1.0.26 already supports close-owned-tab, which detaches CDP and removes the
 * exact adapter-owned tab without invoking page navigation.
 */
export async function closeOwnedTab(page) {
  if (!page?.session) return { skipped: 'no-adapter-session' };
  const sendCommand = await daemonSendCommand();
  return sendCommand('close-owned-tab', {
    session: page.session,
    surface: page.surface ?? 'adapter',
    ...(page.contextId ? { contextId: page.contextId } : {}),
    ...(page.windowMode ? { windowMode: page.windowMode } : {}),
  });
}

/**
 * Run an adapter and close only its owned tab on every exit path.
 *
 * Cleanup failure is diagnostic only when the business operation succeeded:
 * a published item must not be reported as failed merely because tab cleanup
 * was unavailable. When the operation itself failed, its original error wins.
 */
export function withOwnedTabCleanup(fn, { close = closeOwnedTab, report = console.error } = {}) {
  return async (...args) => {
    const [page] = args;
    let operationError;
    try {
      return await fn(...args);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await close(page);
      } catch (cleanupError) {
        if (!operationError) report('OpenCLI owned-tab cleanup failed', cleanupError);
      }
    }
  };
}
