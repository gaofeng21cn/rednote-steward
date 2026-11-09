import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/lib/db.mjs';
import { createBackup, previewRestore, restoreBackup } from '../src/lib/backup.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-backup-'));
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(path.join(stateRoot, 'receipts'), { recursive: true });
  const mediaRoot = path.join(root, 'media');
  await fs.mkdir(mediaRoot);
  const media = Buffer.from('synthetic approved media');
  const mediaFile = path.join(mediaRoot, 'asset.png');
  await fs.writeFile(mediaFile, media);
  const sha = createHash('sha256').update(media).digest('hex');
  const database = openDatabase(path.join(stateRoot, 'xhs-ops.sqlite'));
  database.exec('PRAGMA wal_autocheckpoint=0');
  const now = new Date().toISOString();
  const insert = database.prepare(`INSERT INTO tasks
    (id,fingerprint,kind,account,title,body,topics_json,images_json,manifest_path,package_dir,state,created_at,updated_at,authorization,runner_pid,adapter_pid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id,state] of [['xhs_01','queued'],['xhs_02','running'],['xhs_03','verified']]) {
    insert.run(id, 'frozen-version', 'publish', 'demo', 'A trip', 'An unchanged caption', '[]',
      JSON.stringify([{ path: mediaFile, sha256: sha }]), path.join(mediaRoot, 'post.json'), mediaRoot, state, now, now, 'Existing batch authorization', 999991, 999992);
  }
  const receipt = path.join(stateRoot, 'receipts', 'xhs_03-1.json');
  await fs.writeFile(receipt, JSON.stringify({ taskId:'xhs_03', body: `${mediaRoot}/verbatim caption` }));
  database.prepare('INSERT INTO events(task_id,event,payload_json,created_at) VALUES (?,?,?,?)').run('xhs_03','adapter_finished',JSON.stringify({ receipt, body:`${mediaRoot}/verbatim caption` }),now);
  const account = { schemaVersion:1,accounts:[{alias:'demo',userId:'demo-account',profile:'demo-profile'}] };
  await fs.writeFile(path.join(stateRoot,'accounts.json'), JSON.stringify(account));
  t.after(async () => { database.close(); await fs.rm(root,{recursive:true,force:true}); });
  return { root,stateRoot,mediaRoot,mediaFile,media,database,account };
}

test('online snapshot includes WAL rows, configuration and referenced receipts without media', async t => {
  const f=await fixture(t);
  assert.ok((await fs.stat(path.join(f.stateRoot,'xhs-ops.sqlite-wal'))).size > 0);
  const result=await createBackup({stateRoot:f.stateRoot,destination:path.join(f.root,'snapshot')});
  assert.equal(result.manifest.counts.tasks,3);
  assert.equal(result.manifest.queued,1);
  assert.equal(result.manifest.mediaIncluded,false);
  assert.equal(result.manifest.browserCredentialsIncluded,false);
  assert.ok(result.manifest.files.some(file=>file.path==='receipts/xhs_03-1.json'));
  assert.equal(result.manifest.files.some(file=>file.path==='asset.png'),false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.backupRoot,'accounts.json'))),f.account);
  const snapshot=new DatabaseSync(path.join(result.backupRoot,'xhs-ops.sqlite'),{readOnly:true});
  try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,3); }
  finally { snapshot.close(); }
});

test('restore preview is read-only; restore preserves authorization, remaps media and leaves running attempts unresolved', async t => {
  const f=await fixture(t);
  const saved=await createBackup({stateRoot:f.stateRoot,destination:path.join(f.root,'snapshot')});
  const target=path.join(f.root,'restored');
  const mapped=path.join(f.root,'relocated media');
  await fs.mkdir(mapped); await fs.writeFile(path.join(mapped,'asset.png'),f.media);
  const options={backupRoot:saved.backupRoot,stateRoot:target,pathMappings:[{from:f.mediaRoot,to:mapped}]};
  const preview=await previewRestore(options);
  assert.equal(preview.dryRun,true);
  assert.equal(preview.mediaChecks.every(item=>item.status==='matched'),true);
  await assert.rejects(fs.stat(target), {code:'ENOENT'});
  const restored=await restoreBackup(options);
  assert.equal(restored.platformWrites,false);
  const db=new DatabaseSync(path.join(target,'xhs-ops.sqlite'),{readOnly:true});
  try {
    const queued=db.prepare('SELECT * FROM tasks WHERE id=?').get('xhs_01');
    assert.equal(queued.state,'queued');
    assert.equal(queued.authorization,'Existing batch authorization');
    assert.equal(queued.runner_pid,null);
    assert.equal(queued.adapter_pid,null);
    assert.equal(queued.package_dir,mapped);
    assert.equal(JSON.parse(queued.images_json)[0].path,path.join(mapped,'asset.png'));
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get('xhs_02').state,'needs_review');
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get('xhs_03').state,'verified');
    const event=JSON.parse(db.prepare('SELECT payload_json FROM events WHERE event=?').get('adapter_finished').payload_json);
    assert.equal(event.receipt,path.join(target,'receipts','xhs_03-1.json'));
    assert.equal(event.body,`${f.mediaRoot}/verbatim caption`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='state_restored'").get().n,3);
  } finally { db.close(); }
  assert.equal(f.database.prepare('SELECT state FROM tasks WHERE id=?').get('xhs_02').state,'running');
  assert.equal(JSON.parse(await fs.readFile(path.join(target,'receipts','xhs_03-1.json'))).taskId,'xhs_03');
});

test('restore refuses changed mapped media and corrupted backup bytes before creating target', async t => {
  const f=await fixture(t);
  const saved=await createBackup({stateRoot:f.stateRoot,destination:path.join(f.root,'snapshot')});
  const mapped=path.join(f.root,'changed'); await fs.mkdir(mapped); await fs.writeFile(path.join(mapped,'asset.png'),'different');
  const target=path.join(f.root,'restored');
  const options={backupRoot:saved.backupRoot,stateRoot:target,pathMappings:[{from:f.mediaRoot,to:mapped}]};
  assert.equal((await previewRestore(options)).mediaChecks[0].status,'mismatch');
  await assert.rejects(restoreBackup(options),/Mapped media is missing or changed/);
  await assert.rejects(fs.stat(target),{code:'ENOENT'});
  await fs.appendFile(path.join(saved.backupRoot,'accounts.json'),'corrupt');
  await assert.rejects(previewRestore({backupRoot:saved.backupRoot,stateRoot:target}),/checksum mismatch/);
});

test('backup and restore reject nested source targets, existing state and manifest traversal', async t => {
  const f=await fixture(t);
  await assert.rejects(createBackup({stateRoot:f.stateRoot,destination:path.join(f.stateRoot,'snapshot')}),/outside the source/);
  const saved=await createBackup({stateRoot:f.stateRoot,destination:path.join(f.root,'snapshot')});
  await assert.rejects(restoreBackup({backupRoot:saved.backupRoot,stateRoot:f.stateRoot}),/empty directory/);
  const manifestPath=path.join(saved.backupRoot,'manifest.json');
  const manifest=JSON.parse(await fs.readFile(manifestPath));
  manifest.files[0].path='../outside.sqlite';
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(previewRestore({backupRoot:saved.backupRoot,stateRoot:path.join(f.root,'target')}),/invalid or duplicate/);
});

test('restore remaps and verifies lineage originals, derivatives, sidecars and catalog source paths', async t => {
  const f=await fixture(t);
  const columns=new Set(f.database.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name));
  if (!columns.has('media_lineage_json')) f.database.exec('ALTER TABLE tasks ADD COLUMN media_lineage_json TEXT');
  const original=path.join(f.mediaRoot,'original.png'), sidecar=path.join(f.mediaRoot,'media-lineage.json');
  const originalBytes=Buffer.from('synthetic untouched original');
  await fs.writeFile(original,originalBytes); await fs.writeFile(sidecar,'[]');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const lineage=[{source:original,derived:f.mediaFile,sourceSha256:hash(originalBytes),derivedSha256:hash(f.media),sidecarPath:sidecar,purpose:'exposure'}];
  f.database.prepare('UPDATE tasks SET media_lineage_json=? WHERE id=?').run(JSON.stringify(lineage),'xhs_01');
  f.database.exec('CREATE TABLE IF NOT EXISTS catalog_notes (account_user_id TEXT,note_id TEXT,source_path TEXT)');
  f.database.prepare('INSERT INTO catalog_notes(account_user_id,note_id,source_path) VALUES(?,?,?)').run('demo-account','000000000000000000000001',path.join(f.mediaRoot,'post.json'));
  const saved=await createBackup({stateRoot:f.stateRoot,destination:path.join(f.root,'snapshot')});
  assert.equal(saved.manifest.media.filter(item=>item.field.startsWith('media_lineage_json.')).length,2);
  const mapped=path.join(f.root,'new media'); await fs.mkdir(mapped);
  await fs.writeFile(path.join(mapped,'original.png'),originalBytes); await fs.writeFile(path.join(mapped,'asset.png'),f.media); await fs.writeFile(path.join(mapped,'media-lineage.json'),'[]');
  const target=path.join(f.root,'restored');
  await restoreBackup({backupRoot:saved.backupRoot,stateRoot:target,pathMappings:[{from:f.mediaRoot,to:mapped}]});
  const db=new DatabaseSync(path.join(target,'xhs-ops.sqlite'),{readOnly:true});
  try {
    const entry=JSON.parse(db.prepare('SELECT media_lineage_json FROM tasks WHERE id=?').get('xhs_01').media_lineage_json)[0];
    assert.equal(entry.source,path.join(mapped,'original.png'));
    assert.equal(entry.derived,path.join(mapped,'asset.png'));
    assert.equal(entry.sidecarPath,path.join(mapped,'media-lineage.json'));
    assert.equal(entry.sourceSha256,lineage[0].sourceSha256);
    assert.equal(db.prepare('SELECT source_path FROM catalog_notes').get().source_path,path.join(mapped,'post.json'));
  } finally { db.close(); }
});
