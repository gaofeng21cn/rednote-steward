import assert from 'node:assert/strict';
import test from 'node:test';
import { editArgs, publishArgs } from '../src/lib/opencli.mjs';
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
