#!/usr/bin/env node
// Synthetic browser adapter for controller behavior tests. No network access.
import * as fs from 'node:fs';
const args = process.argv.slice(2);
const command = args[1];
const option = key => args[args.indexOf(key) + 1];
const file = process.env.FAKE_OPENCLI_STATE;
let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { notes: [], writes: 0 };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const progress = (phase, detail) => {
  if (process.env.XHS_OPS_PROGRESS === '1') process.stderr.write(`@@REDNOTE_PROGRESS@@${JSON.stringify({ phase, detail })}\n`);
};
if (command === 'steward-account') output([{ logged_in: true, userId: process.env.FAKE_USER_ID ||
  (process.env.FAKE_USER_ID_BY_PROFILE && process.env.OPENCLI_PROFILE === 'second-profile' ? 'demo-user-002' : 'demo-user-001'), username: 'Example creator', identitySource: 'fixture' }]);
else if (command === 'inventory') output(state.notes.map(note => ({ id: note.noteId, title: note.title })));
else if (command === 'steward-read-note') {
  if (process.env.FAKE_REQUIRE_VIDEO_READ === '1' && option('--note-type') !== 'video') {
    process.stderr.write('The synthetic video note requires the video editor\n'); process.exit(1);
  }
  if (process.env.FAKE_READ_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_READ_DELAY)));
  output(state.notes.filter(note => note.noteId === args[2]));
}
else if (command === 'creator-notes-summary') output([{ id: '000000000000000000000001', title: 'Example', views: 500, collects: 2, comments: 7 }]);
else if (['steward-publish','edit-note'].includes(command)) {
  if (process.env.FAKE_MODE === 'typed-error') {
    output({ error: { code: 'selector_drift', message: 'Synthetic publish control changed' } });
    process.exit(1);
  }
  if (process.env.XHS_OPS_PROGRESS === '1') process.stderr.write('@@REDNOTE_PROGRESS@@{"phase":"prepared","detail":{"mediaReady":true}}\n');
  if (args.includes('--prepare-only')) {
    output([{ status: 'prepared', submitted: false, snapshot: { title: option('--title') }, recovery: { persistedDraftVerified: false } }]);
    process.exit(0);
  }
  if (process.env.XHS_OPS_PROGRESS === '1') process.stderr.write('@@REDNOTE_PROGRESS@@{"phase":"submit_attempted"}\n');
  if (process.env.FAKE_PUBLISH_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_PUBLISH_DELAY)));
  // Reload after the delay so concurrent writes become visible to the test.
  state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : state;
  if (command === 'edit-note' && args.includes('--cover') && !args.includes('--video')) {
    const id = args[2];
    const previous = state.notes.find(note => note.noteId === id);
    const preCoverSource = previous?.cover?.url;
    progress('prepared', { kind: 'edit', noteId: id, stage: 'cover-and-copy', preCoverSource,
      cover: { previousSource: preCoverSource, selectionPending: true } });
    if (process.env.FAKE_MODE === 'cover-only-stage-only') {
      process.stderr.write('Connection lost before custom cover selection\n'); process.exit(1);
    }
    const selected = `https://example.invalid/custom-cover-${state.writes + 1}.jpg`;
    const cover = { preCoverSource, previousSource: preCoverSource, source: selected, confirmationClicked: true,
      selectionVerified: true, identityVerifiedAfterSave: false };
    if (process.env.FAKE_MODE !== 'cover-only-no-evidence') {
      progress('submit_attempted', { kind: 'edit', noteId: id, stage: 'cover-and-copy', cover });
    }
    const row = { ...previous, title: option('--title'), body: option('--content'),
      topics: option('--topics').split(',').filter(Boolean).map((name, i) => ({ id: `topic-${i + 1}`, name })),
      cover: process.env.FAKE_MODE === 'cover-only-keep-cover' ? previous.cover : { url: selected } };
    state.writes++;
    state.notes = [...state.notes.filter(note => note.noteId !== id), row]; save();
    if (['unknown-cover-only','cover-only-keep-cover','cover-only-no-evidence'].includes(process.env.FAKE_MODE)) {
      process.stderr.write('Connection lost after submission\n'); process.exit(1);
    }
    output([{ status: 'submitted', noteId: id, cover: { ...cover, identityVerifiedAfterSave: true } }]);
    process.exit(0);
  }
  state.writes++;
  const id = command === 'edit-note' ? args[2] : state.writes.toString(16).padStart(24, '0');
  const video = args.includes('--video');
  const previous = state.notes.find(note => note.noteId === id);
  const videoNote = video || (command === 'edit-note' && args.includes('--cover') && previous?.mediaType === 'video');
  const stagedCover = command === 'edit-note' && video && args.includes('--cover');
  const topics = option('--topics').split(',').filter(Boolean).map((name, i) => ({ id: `topic-${i + 1}`, name }));
  const row = { noteId: id, title: option('--title'), body: command === 'edit-note' ? option('--content') : args[2], topics,
    imageCount: args.includes('--images') ? option('--images').split(',').length : videoNote ? 0 : 1,
    mediaType: videoNote ? 'video' : 'image', videoPresent: videoNote,
    video: video ? (process.env.FAKE_MODE === 'keep-video' ? previous?.video
      : { src: `https://example.invalid/video-${state.writes}.mp4`, duration: 65.13 })
      : videoNote ? previous?.video : null,
    cover: videoNote ? (stagedCover ? { url: `https://example.invalid/auto-cover-${state.writes}.jpg` }
      : args.includes('--cover')
      ? { url: `https://example.invalid/cover-${state.writes}.jpg` }
      : previous?.cover ?? { url: 'https://example.invalid/cover-original.jpg' }) : null,
    verification: { title: true, body: true, nativeTopics: true, imageCount: true } };
  state.notes = [...state.notes.filter(note => note.noteId !== id), row]; save();
  let preCoverSource = null;
  if (stagedCover) {
    preCoverSource = row.cover.url;
    progress('prepared', { kind: 'edit', noteId: id, stage: 'cover-and-copy', preCoverSource,
      cover: { previousSource: preCoverSource, selectionPending: true } });
    if (process.env.FAKE_MODE === 'video-stage-only') {
      process.stderr.write('Connection lost before custom cover selection\n'); process.exit(1);
    }
    const selected = `https://example.invalid/custom-cover-${state.writes}.jpg`;
    progress('submit_attempted', { kind: 'edit', noteId: id, stage: 'cover-and-copy', cover: {
      preCoverSource, previousSource: preCoverSource, source: selected, confirmationClicked: true,
      selectionVerified: true, identityVerifiedAfterSave: false } });
    state.writes++;
    if (process.env.FAKE_MODE !== 'keep-cover') row.cover = { url: selected };
    save();
  }
  if (['unknown','unknown-cover','keep-cover'].includes(process.env.FAKE_MODE)) { process.stderr.write('Connection lost after submission\n'); process.exitCode = 1; }
  else output([{ status: 'submitted', noteId: id, cover: args.includes('--cover') ? {
    confirmationClicked: true,
    identityVerifiedAfterSave: true,
    previousSource: previous?.cover?.url,
    preCoverSource,
    source: row.cover?.url,
  } : null }]);
} else if (args[0] === 'doctor') output({ ok: true });
else { process.stderr.write(`Unexpected fixture command: ${command}\n`); process.exitCode = 1; }
