#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from './lib/controller.mjs';

const schema = 'opl-package-app-contribution-response.v1';
const refs = ['rednote.steward.v1#tasks', 'rednote.steward.v1#review', 'rednote.steward.v1#media'];
export async function readContribution(request, controller = new Controller()) {
  const envelope = { schema_version: schema, operation: request?.operation, ref: request?.ref };
  try {
    if (request?.schema_version !== 'opl-package-app-contribution-request.v1' || request.operation !== 'read' || !refs.includes(request.ref)) {
      throw new Error('Only declared read-only RedNote contribution refs are supported');
    }
    const input = request.input ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object');
    if (request.ref !== refs[0] && !input.task_id) return { ...envelope, ok: true, result: {
      state: 'input_required', reason: 'Select the exact task returned by ingest or task_review.',
      input_schema: { type: 'object', required: ['task_id'], properties: {
        task_id: { type: 'string', title: 'Task ID' }, fingerprint: { type: 'string', title: 'Content fingerprint' }, revision: { type: 'string', title: 'Task revision' },
      } },
    } };
    for (const name of ['task_id', 'account', 'fingerprint', 'revision']) {
      if (input[name] != null && typeof input[name] !== 'string') throw new Error(`${name} must be a string`);
    }
    if (!input.task_id && (input.fingerprint || input.revision)) throw new Error('An exact task_id is required with a fingerprint or revision');
    const { items } = await controller.review({ taskId: input.task_id, account: input.account, fingerprint: input.fingerprint, revision: input.revision });
    return { ...envelope, ok: true, result: { state: 'ready', data: { items } } };
  } catch (error) { return { ...envelope, ok: false, error: { code: 'rednote_review_failed', message: error.message } }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let result;
  try {
    let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request exceeds 1 MiB'); }
    result = await readContribution(JSON.parse(body));
  }
  catch (error) { result = { schema_version: schema, ok: false, error: { code: 'invalid_request', message: error.message } }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
