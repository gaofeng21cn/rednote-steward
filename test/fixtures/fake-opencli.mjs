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
if (command === 'steward-account') output([{ logged_in: true, userId: process.env.FAKE_USER_ID || 'demo-user-001', username: 'Example creator', identitySource: 'fixture' }]);
else if (command === 'inventory') output(state.notes.map(note => ({ id: note.noteId, title: note.title })));
else if (command === 'steward-read-note') output(state.notes.filter(note => note.noteId === args[2]));
else if (command === 'creator-notes-summary') output([{ id: '000000000000000000000001', title: 'Example', views: 500, collects: 2, comments: 7 }]);
else if (['steward-publish','edit-note'].includes(command)) {
  if (process.env.FAKE_PUBLISH_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_PUBLISH_DELAY)));
  // Reload after the delay so concurrent writes become visible to the test.
  state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : state;
  state.writes++;
  const id = command === 'edit-note' ? args[2] : state.writes.toString(16).padStart(24, '0');
  const video = args.includes('--video');
  const topics = option('--topics').split(',').filter(Boolean).map((name, i) => ({ id: `topic-${i + 1}`, name }));
  const row = { noteId: id, title: option('--title'), body: command === 'edit-note' ? option('--content') : args[2], topics,
    imageCount: args.includes('--images') ? option('--images').split(',').length : video ? 0 : 1,
    mediaType: video ? 'video' : 'image', videoPresent: video, cover: video ? { url: 'https://example.invalid/cover.jpg' } : null,
    verification: { title: true, body: true, nativeTopics: true, imageCount: true } };
  state.notes = [...state.notes.filter(note => note.noteId !== id), row]; save();
  if (process.env.FAKE_MODE === 'unknown') { process.stderr.write('Connection lost after submission\n'); process.exitCode = 1; }
  else output([{ status: 'submitted', noteId: id, cover: args.includes('--cover') ? { confirmationClicked: true } : null }]);
} else if (args[0] === 'doctor') output({ ok: true });
else { process.stderr.write(`Unexpected fixture command: ${command}\n`); process.exitCode = 1; }
