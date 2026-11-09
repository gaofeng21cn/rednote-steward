import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/lib/db.mjs';
import { compareReadback } from '../src/lib/controller.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-opencli.mjs',import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function command(args, env) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,[cli,...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',v=>stdout+=v); child.stderr.on('data',v=>stderr+=v); child.on('error',reject);
    child.on('close',code=>{ let json; try{json=JSON.parse(stdout);}catch{} resolve({code,stdout,stderr,json}); });
  });
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rednote-controller-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const env={...process.env,XHS_OPS_HOME:path.join(root,'private'),XHS_OPS_OPENCLI_BIN:fake,FAKE_OPENCLI_STATE:path.join(root,'platform.json')};
  const account=await command(['account','add','demo','--user-id','demo-user-001','--profile','demo-profile'],env);
  assert.equal(account.code,0,account.stderr);
  async function content(name='Example',extra={}) {
    const dir=path.join(root,name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,'image.png'),png);
    await fs.writeFile(path.join(dir,'post.json'),JSON.stringify({account:'demo',kind:'publish',title:name,body:'A specific street-corner discovery.',topics:['城市漫步'],images:['image.png'],...extra}));
    return dir;
  }
  async function queued(name='Example',extra={}) {
    const dir=await content(name,extra);
    const ingest=await command(['ingest',dir],env); assert.equal(ingest.code,0,ingest.stderr);
    const id=ingest.json.taskId;
    const approval=await command(['approve',id,'--authorization','Owner requested this example batch'],env); assert.equal(approval.code,0,approval.stderr);
    return {id,dir};
  }
  return {root,env,content,queued};
}
async function platform(env) {return JSON.parse(await fs.readFile(env.FAKE_OPENCLI_STATE,'utf8'));}

test('concurrent fresh setup and ingestion preserve one binding and one task',async t=>{
  const f=await fixture(t);
  const dir=await f.content();
  const results=await Promise.all([command(['ingest',dir],f.env),command(['ingest',dir],f.env)]);
  assert.ok(results.every(r=>r.code===0),results.map(r=>r.stderr).join('\n'));
  assert.equal(results[0].json.taskId,results[1].json.taskId);
  assert.equal(results.filter(r=>r.json.duplicate).length,1);
  const freshEnv={...f.env,XHS_OPS_HOME:path.join(f.root,'concurrent-fresh')};
  const first=await Promise.all([command(['init'],freshEnv),command(['init'],freshEnv),command(['init'],freshEnv)]);
  assert.ok(first.every(r=>r.code===0),first.map(r=>r.stderr).join('\n'));
});

test('two CLI processes claim one queued task exactly once',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  const env={...f.env,FAKE_PUBLISH_DELAY:'350'};
  const results=await Promise.all([command(['run',id],env),command(['run',id],env)]);
  assert.equal(results.filter(r=>r.json?.state==='verified').length,1,JSON.stringify(results));
  assert.equal((await platform(env)).writes,1);
  const task=(await command(['show',id],env)).json.task;
  assert.equal(task.attempts,1); assert.equal(task.state,'verified');
});

test('two different tasks for the same account cannot publish concurrently',async t=>{
  const f=await fixture(t); const a=await f.queued('One'); const b=await f.queued('Two');
  const env={...f.env,FAKE_PUBLISH_DELAY:'350'};
  const results=await Promise.all([command(['run',a.id],env),command(['run',b.id],env)]);
  assert.equal((await platform(env)).writes,1);
  assert.equal(results.filter(r=>r.stderr.includes('Account is blocked')).length,1,JSON.stringify(results));
});

test('changing media after ingest fails before a platform write',async t=>{
  const f=await fixture(t); const {id,dir}=await f.queued();
  await fs.appendFile(path.join(dir,'image.png'),'changed');
  const result=await command(['run',id],f.env);
  assert.equal(result.json.state,'failed'); assert.match(result.json.error,/changed after ingest/);
  await assert.rejects(()=>fs.stat(f.env.FAKE_OPENCLI_STATE));
});

test('wrong stable user ID fails even when the browser nickname looks familiar',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  const result=await command(['run',id],{...f.env,FAKE_USER_ID:'someone-else'});
  assert.equal(result.json.state,'failed'); assert.match(result.json.error,/identity mismatch/);
  await assert.rejects(()=>fs.stat(f.env.FAKE_OPENCLI_STATE));
});

test('an unknown submission blocks a second task and reconciles without another write',async t=>{
  const f=await fixture(t); const a=await f.queued('One'); const b=await f.queued('Two');
  const lost=await command(['run',a.id],{...f.env,FAKE_MODE:'unknown'});
  assert.equal(lost.json.state,'needs_review');
  const blocked=await command(['run',b.id],f.env); assert.match(blocked.stderr,/Account is blocked/);
  const approve=await command(['approve',a.id],f.env); assert.match(approve.stderr,/reconcile/);
  const restored=await command(['reconcile',a.id],f.env); assert.equal(restored.json.state,'verified',restored.stderr);
  assert.equal((await platform(f.env)).writes,1);
  assert.equal((await command(['run',b.id],f.env)).json.state,'verified');
  assert.equal((await platform(f.env)).writes,2);
});

test('absence cannot override an observed candidate note',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  await command(['run',id],{...f.env,FAKE_MODE:'unknown'});
  const result=await command(['reconcile',id,'--absent','--reason','An operator assertion'],f.env);
  assert.match(result.stderr,/candidate note exists/); assert.equal((await platform(f.env)).writes,1);
});

test('future tasks remain queued even when explicitly selected',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  await command(['approve',id,'--at','2099-01-01T00:00:00Z'],f.env);
  const result=await command(['run',id],f.env); assert.match(result.stderr,/scheduled/);
  assert.equal((await command(['show',id],f.env)).json.task.state,'queued');
});

test('recovery refuses a live orphaned browser writer',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  const db=openDatabase(path.join(f.env.XHS_OPS_HOME,'xhs-ops.sqlite'));
  db.prepare("UPDATE tasks SET state='running',runner_pid=99999999,adapter_pid=?,write_started_at=? WHERE id=?").run(process.pid,new Date().toISOString(),id); db.close();
  const result=await command(['reconcile',id],f.env); assert.match(result.stderr,/writer is still running/);
});

test('a new attempt clears previous submission markers before recovery',async t=>{
  const f=await fixture(t); const {id}=await f.queued();
  const db=openDatabase(path.join(f.env.XHS_OPS_HOME,'xhs-ops.sqlite'));
  db.prepare("UPDATE tasks SET attempts=1,write_started_at=?,baseline_ids_json='[]',readback_json='{}' WHERE id=?").run('2020-01-01T00:00:00Z',id); db.close();
  const result=await command(['run',id],{...f.env,FAKE_USER_ID:'wrong-user'}); assert.equal(result.json.state,'failed');
  const show=(await command(['show',id],f.env)).json;
  assert.equal(show.task.write_started_at,null); assert.equal(show.task.baseline_ids,null); assert.equal(show.task.readback,null);
  assert.equal(show.events.find(e=>e.event==='execution_claimed').payload.previousAttempt.writeStartedAt,'2020-01-01T00:00:00Z');
});

test('plain topic text and missing custom-cover confirmation never produce verified',()=>{
  const task={title:'Example',body:'Caption',topics:['城市漫步'],images:[{sha256:'synthetic'}],platform_note_id:'000000000000000000000001'};
  const row={noteId:task.platform_note_id,title:task.title,body:task.body,topics:['城市漫步'],imageCount:1,mediaType:'image',verification:{title:true,body:true,nativeTopics:true,imageCount:true}};
  assert.equal(compareReadback(task,row).matched,false);
  const videoTask={...task,kind:'publish',images:[],video:{path:'clip.mp4'},cover:{path:'cover.png'}};
  const videoRow={...row,topics:[{id:'topic-1',name:'城市漫步'}],mediaType:'video',videoPresent:true,video:{duration:65.13},cover:{url:'https://example.invalid/cover'}};
  assert.equal(compareReadback(videoTask,videoRow).matched,false);
  assert.equal(compareReadback(videoTask,videoRow,{cover:{confirmationClicked:true}}).matched,true);
});

test('video with a custom cover flows through publication and explicit field verification',async t=>{
  const f=await fixture(t);
  const dir=await f.content('Video example',{images:[],video:'clip.mp4',cover:'image.png'});
  await fs.writeFile(path.join(dir,'clip.mp4'),Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));
  const id=(await command(['ingest',dir],f.env)).json.taskId;
  await command(['approve',id],f.env);
  const result=await command(['run',id],f.env);
  assert.equal(result.json.state,'verified',result.stderr);
  assert.equal(result.json.verification.limits.customCover,'selection-confirmed-and-cover-present');
  assert.equal(result.json.verification.limits.mediaBytes,'not-compared');
  assert.equal((await platform(f.env)).writes,1);
});

async function videoEdit(t, { cover = false, imageTarget = false } = {}) {
  const f = await fixture(t);
  const noteId = '00000000000000000000000a';
  const original = { noteId, title: 'Previous edition', body: 'Original caption', topics: [],
    imageCount: imageTarget ? 1 : 0, mediaType: imageTarget ? 'image' : 'video', videoPresent: !imageTarget,
    video: imageTarget ? null : { src: 'https://example.invalid/previous.mp4', duration: 65.13 },
    verification: { title: true, body: true, nativeTopics: true, imageCount: true } };
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ notes: [original], writes: 0 }));
  const dir = await f.content('Revised video', { kind: 'edit', sourceNoteId: noteId,
    images: [], video: 'clip.mp4', ...(cover ? { cover: 'image.png' } : {}) });
  await fs.writeFile(path.join(dir, 'clip.mp4'), Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));
  const imported = await command(['ingest', dir], f.env);
  assert.equal(imported.code, 0, imported.stderr);
  await command(['approve', imported.json.taskId, '--authorization', 'Replace this synthetic edition'], f.env);
  return { ...f, id: imported.json.taskId, noteId };
}

test('video replacement and cover keep the same note ID with changed saved media', async t => {
  const f = await videoEdit(t, { cover: true });
  const result = await command(['run', f.id], f.env);
  assert.equal(result.json.state, 'verified', JSON.stringify(result));
  assert.equal(result.json.platformNoteId, f.noteId);
  assert.equal(result.json.verification.checks.videoReplacement, true);
  assert.equal(result.json.verification.limits.mediaBytes, 'not-compared');
  const state = await platform(f.env);
  assert.equal(state.notes.length, 1);
  assert.equal(state.writes, 1);
});

test('a timed-out video replacement reconciles the saved note without resubmitting', async t => {
  const f = await videoEdit(t);
  const unknown = await command(['run', f.id], { ...f.env, FAKE_MODE: 'unknown' });
  assert.equal(unknown.json.state, 'needs_review');
  const result = await command(['reconcile', f.id], f.env);
  assert.equal(result.json.state, 'verified', JSON.stringify(result));
  assert.equal(result.json.platformNoteId, f.noteId);
  assert.equal((await platform(f.env)).writes, 1);
});

test('matching copy and duration cannot verify a video that remained unchanged', async t => {
  const f = await videoEdit(t);
  const result = await command(['run', f.id], { ...f.env, FAKE_MODE: 'keep-video' });
  assert.equal(result.json.state, 'submitted');
  assert.equal(result.json.verification.checks.videoReplacement, false);
  assert.equal((await platform(f.env)).writes, 1);
});

test('a video replacement cannot write to an image note', async t => {
  const f = await videoEdit(t, { imageTarget: true });
  const result = await command(['run', f.id], f.env);
  assert.equal(result.json.state, 'failed');
  assert.match(result.json.error, /existing video note/);
  assert.equal((await platform(f.env)).writes, 0);
});

test('an unchanged edit can be cleared only after reading its saved baseline', async t => {
  const f = await videoEdit(t);
  const original = (await platform(f.env)).notes[0];
  const db = openDatabase(path.join(f.env.XHS_OPS_HOME, 'xhs-ops.sqlite'));
  db.prepare("UPDATE tasks SET state='needs_review',baseline_note_json=?,write_started_at=? WHERE id=?")
    .run(JSON.stringify(original), new Date().toISOString(), f.id);
  db.close();
  const cleared = await command(['reconcile', f.id, '--absent', '--reason',
    'Inspected the unchanged note and composer; no replacement remains in progress.'], f.env);
  assert.equal(cleared.json.state, 'failed', JSON.stringify(cleared));
  assert.equal(cleared.json.retryRequiresAuthorization, true);
  assert.equal((await platform(f.env)).writes, 0);
});

test('operator absence cannot override a changed edit target or missing baseline', async t => {
  const f = await videoEdit(t);
  const original = (await platform(f.env)).notes[0];
  const db = openDatabase(path.join(f.env.XHS_OPS_HOME, 'xhs-ops.sqlite'));
  db.prepare("UPDATE tasks SET state='needs_review',baseline_note_json=? WHERE id=?").run(JSON.stringify(original), f.id);
  const changed = { ...original, body: 'A saved partial revision' };
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ notes: [changed], writes: 0 }));
  const refused = await command(['reconcile', f.id, '--absent', '--reason', 'No change expected'], f.env);
  assert.match(refused.stderr, /target changed/);
  db.prepare('UPDATE tasks SET baseline_note_json=NULL WHERE id=?').run(f.id);
  db.close();
  const noBaseline = await command(['reconcile', f.id, '--absent', '--reason', 'No change expected'], f.env);
  assert.match(noBaseline.stderr, /baseline is incomplete/);
});
