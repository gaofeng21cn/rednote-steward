import assert from 'node:assert/strict';
import test from 'node:test';
import { editArgs, publishArgs, runOpencli } from '../src/lib/opencli.mjs';
const base = { body:'Caption', title:'Example', topics:['城市漫步'], source_note_id:'000000000000000000000001', images:[] };
test('an edit retains original media when no replacement is frozen', () => {
  const args = editArgs(base); assert.equal(args.includes('--images'),false); assert.equal(args[args.indexOf('--topics')+1],'城市漫步');
});
test('image replacement keeps the complete frozen order', () => {
  const args = editArgs({...base,images:[{path:'/tmp/one.jpg'},{path:'/tmp/two.jpg'}]});
  assert.equal(args[args.indexOf('--images')+1],'/tmp/one.jpg,/tmp/two.jpg');
});
test('video publisher uses the separate video and cover controls', () => {
  const args=publishArgs({...base,video:{path:'/tmp/clip.mp4'},cover:{path:'/tmp/cover.jpg'}});
  assert.equal(args[1],'steward-publish'); assert.equal(args.includes('--images'),false);
  assert.equal(args[args.indexOf('--video')+1],'/tmp/clip.mp4'); assert.equal(args[args.indexOf('--cover')+1],'/tmp/cover.jpg');
});
test('video edit replaces the original media on the same note', () => {
  const args=editArgs({...base,images:[],video:{path:'/tmp/clip.mp4'},cover:{path:'/tmp/cover.png'}});
  assert.equal(args[1],'edit-note');
  assert.equal(args[2],'000000000000000000000001');
  assert.equal(args[args.indexOf('--video')+1],'/tmp/clip.mp4');
  assert.equal(args[args.indexOf('--cover')+1],'/tmp/cover.png');
  assert.equal(args.includes('--images'),false);
});
test('controller timeout propagates to the browser command timeout', async () => {
  const previous = process.env.XHS_OPS_OPENCLI_BIN;
  process.env.XHS_OPS_OPENCLI_BIN = process.execPath;
  try {
    const result = await runOpencli(
      ['-e', 'console.log(JSON.stringify({timeout:process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT}))'],
      { timeoutMs: 120000 },
    );
    assert.equal(result.exitCode,0);
    assert.equal(result.json.timeout,'115');
  } finally {
    if (previous == null) delete process.env.XHS_OPS_OPENCLI_BIN;
    else process.env.XHS_OPS_OPENCLI_BIN = previous;
  }
});
