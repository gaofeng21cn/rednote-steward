import assert from 'node:assert/strict';
import test from 'node:test';
import { editArgs, publishArgs, runOpencli } from '../src/lib/opencli.mjs';
import { createProgressReader, PROGRESS_PREFIX } from '../src/lib/progress.mjs';
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
test('prepare-only keeps the explicit composer and declarations are opt-in', () => {
  const args = publishArgs({ ...base, images: [{ path: '/tmp/image.png' }], declarations: { original: true, aiGenerated: false } },
    { prepareOnly: true, keepTab: true });
  assert.equal(args[args.indexOf('--prepare-only') + 1], 'true');
  assert.equal(args[args.indexOf('--keep-tab') + 1], 'true');
  assert.equal(args[args.indexOf('--original') + 1], 'true');
  assert.equal(args[args.indexOf('--ai-declaration') + 1], 'false');
  assert.equal(publishArgs({ ...base, images: [] }).includes('--original'), false);
  assert.throws(() => editArgs({ ...base, declarations: { original: 'true' } }), /must be a boolean/);
});
test('progress decoding handles UTF-8, a trailing record and malformed or oversized lines', () => {
  const events = [], diagnostics = [];
  const reader = createProgressReader(event => events.push(event), value => diagnostics.push(value));
  const bytes = Buffer.from(`${PROGRESS_PREFIX}${JSON.stringify({ phase: 'uploading', detail: { label: '图片' } })}\n`);
  const split = bytes.indexOf(Buffer.from('图')) + 1;
  reader.write(bytes.subarray(0, split));
  reader.write(bytes.subarray(split));
  reader.write(Buffer.from(`${PROGRESS_PREFIX}{bad}\n${PROGRESS_PREFIX}{"phase":"not-real"}\n`));
  reader.write(Buffer.from(`${PROGRESS_PREFIX}${'x'.repeat(20_000)}\nplain diagnostic\n`));
  reader.write(Buffer.from(`${PROGRESS_PREFIX}{"phase":"prepared"}`));
  reader.end();
  assert.deepEqual(events.map(event => event.phase), ['uploading', 'prepared']);
  assert.equal(events[0].detail.label, '图片');
  assert.match(diagnostics.join(''), /malformed/);
  assert.match(diagnostics.join(''), /invalid/);
  assert.match(diagnostics.join(''), /oversized/);
  assert.match(diagnostics.join(''), /plain diagnostic/);
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

test('runOpencli decodes split progress events from stderr without contaminating stdout', async () => {
  const previous = process.env.XHS_OPS_OPENCLI_BIN;
  process.env.XHS_OPS_OPENCLI_BIN = process.execPath;
  const events = [];
  try {
    const script = `const p='@@REDNOTE_PROGRESS@@'; process.stdout.write(JSON.stringify({ok:true})+'\\n'); process.stderr.write(p+'{"phase":"upload'); setTimeout(()=>process.stderr.write('ing","detail":{"index":1}}\\n'+p+'{"phase":"prepared"}\\n'),5);`;
    const result = await runOpencli(['-e', script], { timeoutMs: 5000, onProgress: event => events.push(event) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.json, { ok: true });
    assert.deepEqual(events.map(event => event.phase), ['uploading', 'prepared']);
    assert.equal(result.progress.length, 2);
  } finally {
    if (previous == null) delete process.env.XHS_OPS_OPENCLI_BIN;
    else process.env.XHS_OPS_OPENCLI_BIN = previous;
  }
});

test('a progress persistence failure terminates the one adapter process', async () => {
  const previous = process.env.XHS_OPS_OPENCLI_BIN;
  process.env.XHS_OPS_OPENCLI_BIN = process.execPath;
  let callbacks = 0;
  try {
    const script = `process.stderr.write('@@REDNOTE_PROGRESS@@{"phase":"prepared"}\\n'); setInterval(()=>{},1000);`;
    const result = await runOpencli(['-e', script], { timeoutMs: 5000, onProgress: () => {
      callbacks++;
      throw new Error('synthetic storage unavailable');
    } });
    assert.equal(result.exitCode, -1);
    assert.equal(result.timedOut, false);
    assert.match(result.stderr, /Progress persistence failed: synthetic storage unavailable/);
    assert.equal(callbacks, 1);
  } finally {
    if (previous == null) delete process.env.XHS_OPS_OPENCLI_BIN;
    else process.env.XHS_OPS_OPENCLI_BIN = previous;
  }
});
