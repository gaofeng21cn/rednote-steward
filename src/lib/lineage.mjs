import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function filePath(value, directory, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must name a local file`);
  return path.resolve(directory,value);
}
function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    return { format:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,16) === 'WEBPVP8X') {
    return { format:'webp',width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset=2;
    while (offset+9 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker=bytes[offset+1];
      if (marker===216 || marker===1 || (marker>=208 && marker<=215)) { offset+=2; continue; }
      if (marker===217 || marker===218) break;
      const length=bytes.readUInt16BE(offset+2);
      if (length<2 || offset+2+length>bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        return { format:'jpeg',width:bytes.readUInt16BE(offset+7),height:bytes.readUInt16BE(offset+5) };
      }
      offset+=length+2;
    }
    return { format:'jpeg',width:null,height:null };
  }
  return null;
}

/** Deterministic file metadata; optional ffprobe adds stream evidence without transcoding. */
export async function inspectMediaMetadata(file, { ffprobe = false } = {}) {
  const absolute=path.resolve(file), stat=await fs.stat(absolute);
  if (!stat.isFile() || !stat.size) throw new Error('Media metadata requires a nonempty file');
  const handle=await fs.open(absolute,'r'), buffer=Buffer.alloc(Math.min(stat.size,262144));
  try { await handle.read(buffer,0,buffer.length,0); } finally { await handle.close(); }
  const image=imageDimensions(buffer);
  if (image) return { kind:'image',bytes:stat.size,...image,decoded:false,orientation:null,colorSpace:null };
  const container=buffer.length>=12 && buffer.toString('ascii',4,8)==='ftyp' ? buffer.toString('ascii',8,12).trim() : null;
  const metadata={ kind:container?'video':'unknown',bytes:stat.size,container,decoded:false };
  if (!ffprobe || !container) return metadata;
  try {
    const {stdout}=await exec(typeof ffprobe==='string'?ffprobe:'ffprobe',['-v','error','-show_format','-show_streams','-of','json',absolute],{timeout:10000,maxBuffer:1024*1024});
    const result=JSON.parse(stdout), streams=Array.isArray(result.streams)?result.streams:[];
    return { ...metadata,probe:'ffprobe',duration:Number.isFinite(Number(result.format?.duration))?Number(result.format.duration):null,
      streams:streams.map(stream=>({type:stream.codec_type,codec:stream.codec_name,width:stream.width??null,height:stream.height??null,
        sampleRate:stream.sample_rate?Number(stream.sample_rate):null,channels:stream.channels??null,duration:stream.duration?Number(stream.duration):null})),
      hasVideo:streams.some(stream=>stream.codec_type==='video'),hasAudio:streams.some(stream=>stream.codec_type==='audio') };
  } catch(error) {
    return { ...metadata,probe:'unavailable',reason:error.code==='ENOENT'?'ffprobe is not installed':String(error.message).split('\n')[0] };
  }
}

/** Original/derived chains must lead to selected upload bytes. No file is modified. */
export async function inspectLineage(input, packageDir, media) {
  if (input == null) return [];
  let entries=input, sidecarPath=null;
  if (typeof input==='string') {
    sidecarPath=filePath(input,packageDir,'mediaLineage');
    entries=JSON.parse(await fs.readFile(sidecarPath,'utf8'));
  }
  if (!Array.isArray(entries)) {
    const document=object(entries,'mediaLineage');
    if (document.schemaVersion!==1) throw new Error('Unsupported mediaLineage schemaVersion');
    entries=document.entries;
  }
  if (!Array.isArray(entries)) throw new Error('mediaLineage must be an array or a schemaVersion 1 sidecar');
  if (entries.length>40) throw new Error('mediaLineage supports at most 40 relationships');
  const mediaByPath=new Map(media.map(asset=>[asset.path,asset]));
  const seen=new Set(), result=[];
  for (const item of entries) {
    const entry=object(item,'mediaLineage entry');
    const source=filePath(entry.source??entry.sourcePath,packageDir,'lineage source');
    const derived=filePath(entry.derived??entry.output??entry.derivedPath,packageDir,'lineage derived');
    const selected=mediaByPath.get(derived);
    const sourceStat=await fs.stat(source);
    if (!sourceStat.isFile() || !sourceStat.size) throw new Error('Lineage source must be a nonempty file');
    const derivedStat=await fs.stat(derived);
    if (!derivedStat.isFile() || !derivedStat.size) throw new Error('Lineage derived must be a nonempty file');
    const sourceSha256=await hashFile(source), derivedSha256=selected?.sha256??await hashFile(derived);
    if (entry.sourceSha256!=null && entry.sourceSha256!==sourceSha256) throw new Error('Lineage source hash does not match its file');
    if (entry.derivedSha256!=null && entry.derivedSha256!==derivedSha256) throw new Error('Lineage derived hash does not match upload bytes');
    const purpose=String(entry.purpose??'original').trim();
    if (!purpose || purpose.length>80) throw new Error('Lineage purpose must describe the selected media use');
    if (source===derived && purpose!=='original') throw new Error('A transformed derivative must preserve its original at a separate path');
    if (entry.parameters!=null) object(entry.parameters,'lineage parameters');
    if (entry.metadata!=null) object(entry.metadata,'lineage metadata');
    const key=`${sourceSha256}:${derivedSha256}:${purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({source,derived,sourceSha256,derivedSha256,purpose,tool:entry.tool==null?null:String(entry.tool),
      parameters:entry.parameters??{},metadata:entry.metadata??{},sourceBytes:sourceStat.size,derivedBytes:derivedStat.size,selectedForUpload:Boolean(selected),
      ...(sidecarPath?{sidecarPath}:{})});
  }
  const reachesUpload=(file,visited=new Set())=> {
    if (mediaByPath.has(file)) return true;
    if (visited.has(file)) return false;
    visited.add(file);
    return result.filter(entry=>entry.source===file && entry.derived!==file).some(entry=>reachesUpload(entry.derived,new Set(visited)));
  };
  if (result.some(entry=>!reachesUpload(entry.derived))) throw new Error('Every lineage derivative must lead to media selected for upload');
  return result;
}

export function lineageFingerprint(entries=[]) {
  return entries.map(({sourceSha256,derivedSha256,purpose,tool,parameters,metadata})=>({sourceSha256,derivedSha256,purpose,tool,parameters,metadata}));
}
