import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePackOutput } from '../scripts/lib/npm-pack-output.mjs';

const record = { name: 'rednote-steward', files: [{ path: 'src/cli.mjs' }] };
test('npm pack arrays, keyed objects and single records keep the same file list', () => {
  for (const value of [[record], { 'rednote-steward': record }, record]) {
    assert.deepEqual(parsePackOutput(JSON.stringify(value), 'rednote-steward'), record);
  }
});
test('malformed, ambiguous or unrelated npm pack output cannot skip package checks', () => {
  for (const value of [null, {}, [], { files: [] }, [record, record], { name: 'other', files: [] },
    { name: 'rednote-steward', files: [null] }]) {
    assert.throws(() => parsePackOutput(value, 'rednote-steward'), /Expected one/);
  }
});
