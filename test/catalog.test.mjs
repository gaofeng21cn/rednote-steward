import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../src/lib/db.mjs';
import { importInventory,catalogNotes,updateCatalogNote,upsertSeries,seriesOverview,setInspectionCursor,getInspectionCursor,inspectionCandidates,setAccountPolicy } from '../src/lib/catalog.mjs';

const first='000000000000000000000001',second='000000000000000000000002';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rednote-catalog-'));
  const db=openDatabase(path.join(dir,'state.sqlite'));
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return db;
}
test('inventory imports platform identities without creating publication tasks and preserves local decisions',t=>{
  const db=fixture(t);
  importInventory(db,{account:'travel',accountUserId:'demo-user',notes:[{id:first,title:'路边的旧书店',published_at:'2026-11-01T00:00:00Z'}],capturedAt:'2026-11-08T00:00:00Z'});
  updateCatalogNote(db,{accountUserId:'demo-user',noteId:first,maintenanceStatus:'keep',reason:'The original observation already works',seriesId:'city-walk',episode:1});
  importInventory(db,{account:'travel',accountUserId:'demo-user',notes:[{id:first,title:'书店门口'}],capturedAt:'2026-11-09T00:00:00Z'});
  const note=catalogNotes(db,{accountUserId:'demo-user'}).notes[0];
  assert.equal(note.title,'书店门口');
  assert.equal(note.maintenance_status,'keep');
  assert.equal(note.series_id,'city-walk');
  assert.equal(note.published_at,'2026-11-01T00:00:00Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tasks').get().total,0);
});
test('catalog imports are atomic and scoped to stable account identity',t=>{
  const db=fixture(t);
  assert.throws(()=>importInventory(db,{account:'travel',accountUserId:'a',notes:[{id:first,title:'valid'},{id:'bad'}]}),/24-character/);
  assert.equal(catalogNotes(db,{accountUserId:'a'}).notes.length,0);
  for(const user of ['a','b']) importInventory(db,{account:user,accountUserId:user,notes:[{id:first,title:user}]});
  assert.equal(catalogNotes(db,{accountUserId:'a'}).notes[0].title,'a');
  assert.equal(catalogNotes(db,{accountUserId:'b'}).notes[0].title,'b');
});
test('series distinguish platform episodes from missing and prepared tasks',t=>{
  const db=fixture(t);
  importInventory(db,{account:'medical',accountUserId:'demo',notes:[{id:first,title:'第一集'}]});
  updateCatalogNote(db,{accountUserId:'demo',noteId:first,seriesId:'demo-series',episode:'E01',maintenanceStatus:'keep'});
  upsertSeries(db,{account:'medical',accountUserId:'demo',seriesId:'demo-series',title:'示例系列',expectedEpisodes:['E01','E02','E03']});
  db.prepare(`INSERT INTO tasks (id,fingerprint,kind,account,account_user_id,title,body,topics_json,images_json,manifest_path,package_dir,state,series_id,episode,created_at,updated_at)
    VALUES ('xhs_00000000000000000001','fingerprint','publish','medical','demo','第二集','Body','[]','[]','/synthetic/post.json','/synthetic','queued','demo-series','E02','2026-11-09T00:00:00Z','2026-11-09T00:00:00Z')`).run();
  const result=seriesOverview(db,{accountUserId:'demo'}).series[0];
  assert.deepEqual(result.unpublishedEpisodes,['E02','E03']);
  assert.deepEqual(result.missingEpisodes,['E03']);
  assert.equal(result.tasks[0].state,'queued');
  assert.equal(result.notes[0].note_id,first);
});
test('incremental inspection uses timestamp plus boundary IDs and keeps original decisions',t=>{
  const db=fixture(t);
  importInventory(db,{account:'travel',accountUserId:'demo',notes:[
    {id:first,title:'已经看过',published_at:'2026-11-08T00:00:00Z'},
    {id:second,title:'同一时刻的新帖',published_at:'2026-11-08T00:00:00Z'},
  ]});
  setInspectionCursor(db,{account:'travel',accountUserId:'demo',watermark:'2026-11-08T00:00:00Z',boundaryNoteIds:[first]});
  assert.deepEqual(inspectionCandidates(db,{accountUserId:'demo'}).notes.map(note=>note.note_id),[second]);
  updateCatalogNote(db,{accountUserId:'demo',noteId:second,maintenanceStatus:'keep'});
  assert.equal(inspectionCandidates(db,{accountUserId:'demo'}).notes.length,0);
  setInspectionCursor(db,{account:'travel',accountUserId:'demo',watermark:'2026-11-08T00:00:00Z',boundaryNoteIds:[second]});
  assert.deepEqual(getInspectionCursor(db,{accountUserId:'demo'}).cursor.boundaryNoteIds,[first,second]);
  assert.equal(getInspectionCursor(db,{accountUserId:'demo'}).cursor.watermark,'2026-11-08T00:00:00.000Z');
  assert.throws(()=>setInspectionCursor(db,{account:'travel',accountUserId:'demo',watermark:'2026-11-07T00:00:00Z'}),/backwards/);
});
test('medical account policy can turn inspection off without adding a schedule',t=>{
  const db=fixture(t);
  importInventory(db,{account:'medical',accountUserId:'demo',notes:[{id:first,title:'成片'}]});
  const policy=setAccountPolicy(db,{account:'medical',accountUserId:'demo',policy:{inspectionMode:'off',editorBrief:'Approved educational videos only'}});
  assert.equal(policy.schedulingCreated,false);
  assert.equal(inspectionCandidates(db,{accountUserId:'demo'}).notes.length,0);
});
