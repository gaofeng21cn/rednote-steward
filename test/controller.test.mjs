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
  const env={...process.env,XHS_OPS_HOME:path.join(root,'private'),XHS_OPS_OWNER_HOME:path.join(root,'owners'),XHS_OPS_OPENCLI_BIN:fake,FAKE_OPENCLI_STATE:path.join(root,'platform.json')};
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
  const videoRow={...row,topics:[{id:'topic-1',name:'城市漫步'}],mediaType:'video',videoPresent:true,video:{src:'https://example.invalid/video.mp4',duration:65.13},cover:{url:'https://example.invalid/cover'}};
  assert.equal(compareReadback(videoTask,videoRow).matched,false);
  assert.equal(compareReadback(videoTask,videoRow,{cover:{confirmationClicked:true}}).matched,true);
  const declaredTask = { ...videoTask, declarations: { original: true, aiGenerated: false } };
  assert.equal(compareReadback(declaredTask,videoRow,{cover:{confirmationClicked:true}}).matched,false);
  const saved = { ...videoRow, declarations: { values: { original: true, aiGenerated: false }, verification: 'saved-composer-controls' } };
  assert.equal(compareReadback(declaredTask,saved,{cover:{confirmationClicked:true}}).matched,true);
  const editTask = { ...videoTask, kind: 'edit', source_note_id: task.platform_note_id,
    baseline_note: { ...videoRow, video: { src: 'https://example.invalid/old-video.mp4', duration: 65.13 },
      cover: { url: 'https://example.invalid/old-cover.jpg' } } };
  assert.equal(compareReadback(editTask, { ...videoRow, cover: { url: 'https://example.invalid/old-cover.jpg' } }, {
    cover: { confirmationClicked: true, identityVerifiedAfterSave: true },
  }).matched, false);
  assert.equal(compareReadback(editTask, { ...videoRow, cover: { url: 'https://example.invalid/new-cover.jpg' } }, {
    cover: { confirmationClicked: true, identityVerifiedAfterSave: true },
  }).matched, true);
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
    cover: imageTarget ? null : { url: 'https://example.invalid/cover-original.jpg' },
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

test('batch pause remains effective for tasks authorized after the pause and cancellation is safe', async t => {
  const f = await fixture(t);
  const a = await f.queued('Pause one');
  const paused = await command(['pause', '--account', 'demo', '--reason', 'Pause this series'], f.env);
  assert.equal(paused.json.persistent, true);
  const b = await f.queued('Pause two');
  const noTask = await command(['run', '--account', 'demo'], f.env);
  assert.equal(noTask.json.executed.length, 0);
  const cancelled = await command(['cancel', b.id, '--reason', 'Use another edition'], f.env);
  assert.equal(cancelled.json.state, 'cancelled');
  const resumed = await command(['resume', '--account', 'demo'], f.env);
  assert.ok(resumed.json.resumed.includes(a.id));
  const result = await command(['run', '--account', 'demo'], f.env);
  assert.equal(result.json.taskId, a.id);
  assert.equal(result.json.state, 'verified');
  assert.equal((await platform(f.env)).writes, 1);
});

test('typed adapter errors and prepared-only handoffs retain durable phase without a second submission', async t => {
  const f = await fixture(t);
  const a = await f.queued('Typed error');
  const failure = await command(['run', a.id], { ...f.env, FAKE_MODE: 'typed-error' });
  assert.equal(failure.json.errorCode, 'selector_drift');
  const failed = (await command(['show', a.id], f.env)).json.task;
  assert.equal(failed.last_error_code, 'selector_drift');
  assert.equal(failed.last_error_detail.code, 'selector_drift');
  await command(['reconcile', a.id, '--absent', '--reason', 'Inspected the composer and no submission exists'], f.env);
  const b = await f.queued('Prepare handoff');
  const prepared = await command(['prepare', b.id], f.env);
  assert.equal(prepared.json.submitted, false, JSON.stringify(prepared));
  const show = (await command(['show', b.id], f.env)).json;
  assert.equal(show.task.phase, 'prepared');
  assert.equal(show.task.write_started_at, null);
  assert.equal(show.task.state, 'needs_review');
  assert.ok(show.events.some(event => event.event === 'phase' && event.payload.phase === 'prepared'));
  const direct = await command(['run', b.id], f.env);
  assert.notEqual(direct.code, 0);
  await assert.rejects(() => fs.stat(f.env.FAKE_OPENCLI_STATE));
});

test('manual completion links the original task through readback without publishing', async t => {
  const f = await fixture(t); const { id } = await f.queued('Manual example');
  const noteId = '0000000000000000000000ab';
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ writes: 0, notes: [{ noteId,
    title: 'Manual example', body: 'A specific street-corner discovery.', topics: [{ id: 'topic-1', name: '城市漫步' }],
    imageCount: 1, mediaType: 'image', verification: { title: true, body: true, nativeTopics: true, imageCount: true } }] }));
  const result = await command(['link-existing', id, '--note-id', noteId, '--reason', 'Owner manually completed the prepared post'], f.env);
  assert.equal(result.json.state, 'verified', JSON.stringify(result));
  assert.equal(result.json.publishedByThisCall, false);
  assert.equal(result.json.platformNoteId, noteId);
  assert.equal((await platform(f.env)).writes, 0);
  const readback = (await command(['show', id], f.env)).json;
  assert.ok(readback.events.some(event => event.event === 'manual_publication_claimed'));
});

test('manual linking reserves a queued task before browser awaits so run cannot race a duplicate publish', async t => {
  const f = await fixture(t); const { id } = await f.queued('Manual race');
  const noteId = '0000000000000000000000ac';
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ writes: 0, notes: [{ noteId,
    title: 'Manual race', body: 'A specific street-corner discovery.', topics: [{ id: 'topic-1', name: '城市漫步' }],
    imageCount: 1, mediaType: 'image', verification: { title: true, body: true, nativeTopics: true, imageCount: true } }] }));
  const linking = command(['link-existing', id, '--note-id', noteId, '--reason', 'Manual publication inspected'], { ...f.env, FAKE_READ_DELAY: '350' });
  let reserved = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = (await command(['show', id], f.env)).json.task;
    if (state.phase?.startsWith('manual_link_')) { reserved = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(reserved, true);
  const run = await command(['run', id], f.env);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr,/needs_review/);
  assert.equal((await linking).json.state, 'verified');
  assert.equal((await platform(f.env)).writes, 0);
});

test('batch ingestion assigns an unbatched duplicate but never moves another batch silently', async t => {
  const f = await fixture(t);
  const dir = await f.content('Existing package');
  const first = await command(['ingest', dir], f.env);
  const grouped = await command(['ingest-batch', dir, '--batch', 'trip-a'], f.env);
  assert.equal(grouped.json.results[0].taskId, first.json.taskId);
  assert.equal(grouped.json.summary.included, 1);
  assert.equal((await command(['show', first.json.taskId], f.env)).json.task.batch_id, 'trip-a');
  const another = await command(['ingest-batch', dir, '--batch', 'trip-b'], f.env);
  assert.equal(another.json.summary.excluded, 1);
  assert.equal(another.json.results[0].existingBatch, 'trip-a');
});

test('metrics collection keeps both observations and treats missing and zero differently', async t => {
  const f = await fixture(t);
  const first = await command(['collect', '--account', 'demo'], f.env);
  const second = await command(['collect', '--account', 'demo'], f.env);
  assert.equal(first.code, 0, first.stderr); assert.equal(second.code, 0, second.stderr);
  const result = await command(['metrics-history', '--account', 'demo'], f.env);
  assert.equal(result.json.observations.length, 2);
  assert.equal(result.json.observations[0].account_user_id, 'demo-user-001');
  assert.equal(result.json.observations[0].likes, null);
  const db = openDatabase(path.join(f.env.XHS_OPS_HOME, 'xhs-ops.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM metrics').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM metric_observations').get().count, 2);
  db.close();
});

test('missing-baseline legacy attempts support inspected absence without treating title matches as proof', async t => {
  const f = await fixture(t); const { id } = await f.queued('Legacy upload');
  const db = openDatabase(path.join(f.env.XHS_OPS_HOME, 'xhs-ops.sqlite'));
  db.prepare("UPDATE tasks SET state='needs_review',baseline_ids_json=NULL,write_started_at=?,phase='prepared' WHERE id=?").run(new Date().toISOString(), id);
  db.close();
  const unresolved = await command(['reconcile', id], f.env);
  assert.equal(unresolved.json.state, 'needs_review');
  const candidateId = '0000000000000000000000aa';
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ writes: 0, notes: [{ noteId: candidateId, title: 'Legacy upload' }] }));
  const candidates = await command(['reconcile', id, '--absent', '--reason', 'Composer inspected'], f.env);
  assert.equal(candidates.json.state, 'needs_review');
  assert.equal(candidates.json.candidates[0].noteId, candidateId);
  await fs.writeFile(f.env.FAKE_OPENCLI_STATE, JSON.stringify({ writes: 0, notes: [] }));
  const cleared = await command(['reconcile', id, '--absent', '--reason', 'Read account inventory and inspected composer; no note or active upload exists'], f.env);
  assert.equal(cleared.json.state, 'failed');
  assert.equal(cleared.json.retryRequiresAuthorization, true);
  assert.equal((await platform(f.env)).writes, 0);
});

test('owner conflicts defer an authorized task without consuming an execution attempt', async t => {
  const f = await fixture(t); const { id } = await f.queued('Owner wait');
  const { DatabaseSync } = await import('node:sqlite');
  const registry = new DatabaseSync(path.join(f.env.XHS_OPS_OWNER_HOME, 'registry.sqlite'));
  registry.prepare('UPDATE account_owners SET home=? WHERE account_user_id=?').run(path.join(f.root, 'other-owner'), 'demo-user-001');
  registry.close();
  const result = await command(['run', id], f.env);
  assert.equal(result.json.state, 'queued');
  assert.equal(result.json.deferred, true);
  assert.equal(result.json.errorCode, 'state_owner_conflict');
  const task = (await command(['show', id], f.env)).json.task;
  assert.equal(task.attempts, 0);
  assert.equal(task.authorization, 'Owner requested this example batch');
  assert.equal(task.phase, 'owner_blocked');
  await assert.rejects(() => fs.stat(f.env.FAKE_OPENCLI_STATE));
});

test('a deferred external owner in a batch does not block another account', async t => {
  const f = await fixture(t);
  const a = await f.queued('Batch owner wait');
  const added = await command(['account','add','second','--user-id','demo-user-002','--profile','second-profile'],f.env);
  assert.equal(added.code,0,added.stderr);
  const second = await f.content('Batch other account',{account:'second'});
  const b = (await command(['ingest',second],f.env)).json.taskId;
  await command(['approve',b],f.env);
  const db=openDatabase(path.join(f.env.XHS_OPS_HOME,'xhs-ops.sqlite'));
  db.prepare('UPDATE tasks SET batch_id=?').run('external-owner-batch'); db.close();
  const { DatabaseSync }=await import('node:sqlite');
  const registry=new DatabaseSync(path.join(f.env.XHS_OPS_OWNER_HOME,'registry.sqlite'));
  registry.prepare('UPDATE account_owners SET home=? WHERE account_user_id=?').run(path.join(f.root,'other-owner'),'demo-user-001'); registry.close();
  const output=await command(['run'],{...f.env,FAKE_USER_ID_BY_PROFILE:'1'});
  assert.equal(output.json.taskId,b,JSON.stringify(output));
  assert.equal(output.json.state,'verified',JSON.stringify(output));
  assert.equal(output.json.deferredTasks.length,1,JSON.stringify(output));
  assert.equal(output.json.deferredTasks[0].taskId,a.id);
  assert.equal((await platform(f.env)).writes,1);
});

test('prepared edits remain unresolved until explicit composer inspection and unchanged baseline confirm absence', async t => {
  const f = await videoEdit(t);
  const prepared = await command(['prepare', f.id], f.env);
  assert.equal(prepared.json.state, 'needs_review');
  assert.equal((await platform(f.env)).writes, 0);
  const unresolved = await command(['reconcile', f.id], f.env);
  assert.equal(unresolved.json.state, 'submitted');
  const cleared = await command(['reconcile', f.id, '--absent', '--reason', 'Read the unchanged saved video and closed the inspected prepared composer'], f.env);
  assert.equal(cleared.json.state, 'failed', JSON.stringify(cleared));
  assert.equal(cleared.json.retryRequiresAuthorization, true);
  assert.equal((await platform(f.env)).writes, 0);
});
