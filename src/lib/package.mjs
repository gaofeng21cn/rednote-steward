import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function unicodeLength(value) { return [...String(value ?? '')].length; }
export function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n\n');
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function contentFingerprint({ kind, account, sourceNoteId, replacesNoteId, title, body, topics, images, video, cover, subtitle }) {
  return sha256(JSON.stringify({ platform: 'xiaohongshu', kind, account,
    sourceNoteId: sourceNoteId || null, replacesNoteId: replacesNoteId || null,
    title, body, topics, images: images.map(item => item.sha256),
    video: video?.sha256 ?? null, cover: cover?.sha256 ?? null, subtitle: subtitle?.sha256 ?? null }));
}
function text(value, label, { required = true, max = 0 } = {}) {
  if (value != null && typeof value !== 'string') throw new Error(`${label} must be a string`);
  const result = (value ?? '').trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (max && unicodeLength(result) > max) throw new Error(`${label} exceeds ${max} characters`);
  return result;
}
function noteId(value, label) {
  const result = text(value, label);
  if (!/^[a-f0-9]{24}$/i.test(result)) throw new Error(`${label} must be a 24-character note ID`);
  return result.toLowerCase();
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
async function mediaFile(value, packageDir, type) {
  const file = path.resolve(packageDir, text(value, type));
  if (file.includes(',')) throw new Error(`${type} path contains a comma unsupported by the browser adapter`);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`${type} must be a nonempty file`);
  const handle = await fs.open(file, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const ext = path.extname(file).toLowerCase();
  let format = ext.slice(1);
  if (type === 'image' || type === 'cover') {
    format = imageType(header);
    if (!format || !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      throw new Error(`${type} must contain JPEG, PNG or WebP bytes: ${file}`);
    }
  } else if (type === 'video') {
    if (!['.mp4', '.mov', '.m4v'].includes(ext) || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw new Error(`video must be an MP4/MOV container: ${file}`);
    }
  } else if (!['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) {
    throw new Error('subtitle must be an SRT, VTT, ASS or SSA file');
  }
  return { path: file, name: path.basename(file), bytes: stat.size, format, sha256: await hashFile(file) };
}

export async function inspectPackage(input) {
  const absolute = path.resolve(input);
  const stat = await fs.stat(absolute);
  const manifestPath = stat.isDirectory() ? path.join(absolute, 'post.json') : absolute;
  const packageDir = path.dirname(manifestPath);
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Package must be a JSON object');
  if (raw.schemaVersion != null && raw.schemaVersion !== 1) throw new Error('Unsupported schemaVersion');
  if ((raw.platform ?? 'xiaohongshu') !== 'xiaohongshu') throw new Error('Unsupported platform');
  const kind = raw.kind ?? 'publish';
  if (!['publish', 'edit'].includes(kind)) throw new Error('kind must be publish or edit');
  const account = text(raw.account, 'account');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new Error('account must be an alias using letters, numbers, _ or -');
  const title = text(raw.title, 'title', { max: 20 });
  const body = text(raw.body, 'body', { required: kind === 'publish', max: 1000 }).replace(/\r\n?/g, '\n');
  if (!Array.isArray(raw.topics)) throw new Error('topics must be an array of platform topic names');
  const topics = [...new Set(raw.topics.map(value => text(value, 'topic').replace(/^#/, '')))];
  if (topics.length > 10 || topics.some(topic => !topic || topic.includes(','))) throw new Error('topics supports at most 10 names without commas');
  const sourceNoteId = kind === 'edit' ? noteId(raw.sourceNoteId ?? raw.id, 'sourceNoteId') : null;
  const replacesNoteId = raw.replacesNoteId ? noteId(raw.replacesNoteId, 'replacesNoteId') : null;
  if (raw.images != null && !Array.isArray(raw.images)) throw new Error('images must be an array');
  const imagePaths = raw.images ?? [];
  if (imagePaths.length > 18) throw new Error('images supports at most 18 entries');
  if (raw.video && imagePaths.length) throw new Error('Choose video or images for one package');
  if ((raw.cover || raw.subtitle) && !raw.video) throw new Error('cover and subtitle require video');
  if (kind === 'edit' && raw.video) throw new Error('Video file replacement is not supported; publish a new version with replacesNoteId');
  const images = [];
  for (const [index, value] of imagePaths.entries()) images.push({ order: index + 1, ...await mediaFile(value, packageDir, 'image') });
  const video = raw.video ? await mediaFile(raw.video, packageDir, 'video') : null;
  const cover = raw.cover ? await mediaFile(raw.cover, packageDir, 'cover') : null;
  const subtitle = raw.subtitle ? await mediaFile(raw.subtitle, packageDir, 'subtitle') : null;
  if (kind === 'publish' && !images.length && !video) throw new Error('publish packages require at least one image or a video');
  if (raw.publishAt && Number.isNaN(Date.parse(raw.publishAt))) throw new Error('publishAt must be an ISO date');
  const warnings = [];
  if (/(^|\s)#\S+/.test(body)) warnings.push('Plain hashtags in the body do not create native topic associations.');
  if (kind === 'edit' && !images.length) warnings.push('Existing media will be preserved.');
  if (subtitle) warnings.push('Subtitle is a provenance asset. Use a final video with subtitles already rendered; separate subtitle upload is not supported.');
  const result = { schemaVersion: 1, manifestPath, packageDir, platform: 'xiaohongshu', kind, account,
    sourceNoteId, replacesNoteId, title, body, topics, images, imageCount: images.length,
    video, cover, subtitle, mediaType: video ? 'video' : 'image',
    publishAt: raw.publishAt ? new Date(raw.publishAt).toISOString() : null,
    notes: text(raw.notes, 'notes', { required: false }), warnings };
  return { ...result, fingerprint: contentFingerprint(result) };
}

export async function verifyFrozenPackage(task) {
  const current = await inspectPackage(task.manifest_path);
  if (current.fingerprint !== task.fingerprint) throw new Error('Package content changed after ingest; ingest the current version and authorize it separately');
  // A path change with identical bytes also changes the adapter inputs. Use only the frozen paths.
  for (const asset of [...task.images, task.video, task.cover, task.subtitle].filter(Boolean)) {
    if (await hashFile(asset.path) !== asset.sha256) throw new Error(`Frozen media changed: ${asset.name}`);
  }
  return current;
}
