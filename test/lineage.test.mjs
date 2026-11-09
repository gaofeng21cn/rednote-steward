import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { inspectPackage,verifyFrozenPackage } from '../src/lib/package.mjs';
import { inspectMediaMetadata } from '../src/lib/lineage.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function fixture(t,extra={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rednote-lineage-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'original.png'),png);
  await fs.writeFile(path.join(dir,'share.png'),png);
  const manifest={schemaVersion:1,account:'demo',kind:'publish',title:'街角',body:'旧书店门口。',topics:[],images:['share.png'],...extra};
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify(manifest));
  return {dir,manifest};
}
test('lineage verifies original and selected derivatives while retaining legacy fingerprint stability',async t=>{
  const {dir,manifest}=await fixture(t);
  const legacy=await inspectPackage(dir);
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,declarations:{},mediaLineage:[]}));
  assert.equal((await inspectPackage(dir)).fingerprint,legacy.fingerprint);
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,mediaLineage:[{source:'original.png',derived:'share.png',purpose:'share-redaction',tool:'local-editor',parameters:{removePersonalLabel:true}}]}));
  const prepared=await inspectPackage(dir);
  assert.equal(prepared.mediaLineage[0].selectedForUpload,true);
  assert.equal(prepared.mediaLineage[0].sourceSha256,prepared.images[0].sha256);
  assert.notEqual(prepared.fingerprint,legacy.fingerprint);
  await fs.appendFile(path.join(dir,'original.png'),'original drift');
  await assert.rejects(()=>verifyFrozenPackage({...prepared,manifest_path:prepared.manifestPath}),/Package content changed/);
});
test('lineage sidecars can connect an intermediate derivative to final upload bytes',async t=>{
  const {dir,manifest}=await fixture(t,{mediaLineage:'lineage.json'});
  await fs.writeFile(path.join(dir,'adjusted.png'),png);
  await fs.writeFile(path.join(dir,'lineage.json'),JSON.stringify({schemaVersion:1,entries:[
    {source:'original.png',derived:'adjusted.png',purpose:'exposure-correction'},
    {source:'adjusted.png',derived:'share.png',purpose:'share-redaction'},
  ]}));
  const prepared=await inspectPackage(dir);
  assert.equal(prepared.mediaLineage.length,2);
  assert.equal(prepared.mediaLineage[0].selectedForUpload,false);
  assert.equal(prepared.mediaLineage[1].selectedForUpload,true);
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,mediaLineage:[{source:'original.png',derived:'adjusted.png',purpose:'exposure-correction'}]}));
  await assert.rejects(()=>inspectPackage(dir),/must lead to media selected/);
});
test('lineage rejects false hashes and a transformed file overwriting its original',async t=>{
  const {dir,manifest}=await fixture(t,{mediaLineage:[{source:'original.png',derived:'share.png',purpose:'exposure-correction',sourceSha256:'f'.repeat(64)}]});
  await assert.rejects(()=>inspectPackage(dir),/source hash/);
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,mediaLineage:[{source:'share.png',derived:'share.png',purpose:'exposure-correction'}]}));
  await assert.rejects(()=>inspectPackage(dir),/preserve its original/);
});
test('declarations are explicit booleans and frozen with the package',async t=>{
  const {dir,manifest}=await fixture(t,{seriesId:'travel-notes',episode:1,contentType:'travel-photo',declarations:{original:true,aiGenerated:false}});
  const before=await inspectPackage(dir);
  assert.equal(before.seriesId,'travel-notes');
  assert.deepEqual(before.declarations,{original:true,aiGenerated:false});
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,declarations:{original:false,aiGenerated:false}}));
  assert.notEqual((await inspectPackage(dir)).fingerprint,before.fingerprint);
  await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({...manifest,declarations:{original:'yes'}}));
  await assert.rejects(()=>inspectPackage(dir),/boolean/);
});
test('metadata reports dimensions without claiming image decode or video audio verification',async t=>{
  const {dir}=await fixture(t);
  const image=await inspectMediaMetadata(path.join(dir,'original.png'));
  assert.equal(image.width,1);assert.equal(image.height,1);assert.equal(image.decoded,false);
  await fs.writeFile(path.join(dir,'video.mp4'),Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));
  const video=await inspectMediaMetadata(path.join(dir,'video.mp4'),{ffprobe:'/this-command-does-not-exist'});
  assert.equal(video.kind,'video');assert.equal(video.probe,'unavailable');
  assert.equal(video.hasAudio,undefined);
});
