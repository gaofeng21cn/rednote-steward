import { StringDecoder } from 'node:string_decoder';

export const PROGRESS_PREFIX = '@@REDNOTE_PROGRESS@@';
export const PROGRESS_PHASES = new Set([
  'selected', 'uploading', 'processing', 'prepared', 'submit_attempted',
  'platform_accepted', 'readback',
]);
const MAX_LINE = 16 * 1024;

export function emitProgress(phase, detail) {
  if (process.env.XHS_OPS_PROGRESS !== '1') return;
  if (!PROGRESS_PHASES.has(phase)) throw new Error(`Unknown adapter phase: ${phase}`);
  const event = { phase, ...(detail == null ? {} : { detail }), capturedAt: new Date().toISOString() };
  const line = `${PROGRESS_PREFIX}${JSON.stringify(event)}`;
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error('Adapter progress event exceeds its size limit');
  process.stderr.write(`${line}\n`);
}

/** Decode split UTF-8 NDJSON without retaining an unbounded partial line. */
export function createProgressReader(onProgress, onDiagnostic) {
  const decoder = new StringDecoder('utf8');
  let pending = '', dropping = false;
  const line = (value, newline) => {
    if (!value.startsWith(PROGRESS_PREFIX)) { onDiagnostic(value + newline); return; }
    let event;
    try { event = JSON.parse(value.slice(PROGRESS_PREFIX.length)); } catch {
      onDiagnostic('Ignored malformed adapter progress event\n'); return;
    }
    if (!event || Array.isArray(event) || !PROGRESS_PHASES.has(event.phase) ||
        (event.capturedAt != null && (typeof event.capturedAt !== 'string' || !Number.isFinite(Date.parse(event.capturedAt))))) {
      onDiagnostic('Ignored invalid adapter progress event\n'); return;
    }
    onProgress({ phase: event.phase, ...(event.detail == null ? {} : { detail: event.detail }),
      ...(event.capturedAt ? { capturedAt: event.capturedAt } : {}) });
  };
  const consume = text => {
    while (text.length) {
      const index = text.indexOf('\n');
      const part = index < 0 ? text : text.slice(0, index);
      if (!dropping) {
        pending += part;
        if (Buffer.byteLength(pending) > MAX_LINE) {
          onDiagnostic('Ignored oversized adapter stderr line\n');
          pending = ''; dropping = true;
        }
      }
      if (index < 0) return;
      if (!dropping) line(pending.replace(/\r$/, ''), '\n');
      pending = ''; dropping = false; text = text.slice(index + 1);
    }
  };
  return {
    write(chunk) { consume(decoder.write(chunk)); },
    end() {
      consume(decoder.end());
      if (pending && !dropping) line(pending, '');
      pending = '';
    },
  };
}
