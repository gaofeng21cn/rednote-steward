import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compareVideoFiles,
  parsePsnrOutput,
  parseSsimOutput,
} from '../src/lib/video-compare.mjs';

test('video comparison parses SSIM and stereo PSNR without using duration as identity', () => {
  assert.deepEqual(
    parseSsimOutput('x SSIM Y:0.997804 (26.58) U:0.9 V:0.9 All:0.998145 (26.58)'),
    { y: 0.997804, all: 0.998145 },
  );
  assert.deepEqual(
    parsePsnrOutput('PSNR ch0: 169.057 dB\nPSNR ch1: 168.900 dB'),
    { channel0: 169.057, channel1: 168.9 },
  );
});

test('video comparison reports a content match with separate byte identity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-video-compare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'approved.mp4');
  const platform = path.join(dir, 'readback.mp4');
  await fs.writeFile(local, 'approved synthetic bytes');
  await fs.writeFile(platform, 'transcoded synthetic bytes');
  const runner = async (command, args) => {
    if (args.includes('-show_entries')) {
      return { exitCode: 0, stdout: args.includes(local) ? '10\n' : '10.1\n', stderr: '' };
    }
    if (args.some(arg => String(arg).includes('ssim'))) {
      return { exitCode: 0, stdout: '', stderr: 'SSIM Y:0.997 Y:0 U:0 V:0 All:0.998' };
    }
    if (args.some(arg => String(arg).includes('apsnr'))) {
      return { exitCode: 0, stdout: '', stderr: 'PSNR ch0: 50 dB PSNR ch1: 49 dB' };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const result = await compareVideoFiles(local, platform, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'match');
  assert.equal(result.byteIdentical, false);
  assert.equal(result.comparison.visualSsim, 0.998);
  assert.equal(result.comparison.audioPsnrDb, 49);
  assert.ok(Math.abs(result.comparison.durationDeltaSeconds - 0.1) < 1e-9);
});

test('video comparison keeps low similarity as review-required evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-video-mismatch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'approved.mp4');
  const platform = path.join(dir, 'readback.mp4');
  await fs.writeFile(local, 'approved synthetic bytes');
  await fs.writeFile(platform, 'different synthetic bytes');
  const runner = async (_command, args) => {
    if (args.includes('-show_entries')) return { exitCode: 0, stdout: '10\n', stderr: '' };
    if (args.some(arg => String(arg).includes('ssim'))) return { exitCode: 0, stdout: '', stderr: 'SSIM Y:0.1 All:0.2' };
    if (args.some(arg => String(arg).includes('apsnr'))) return { exitCode: 0, stdout: '', stderr: 'PSNR ch0: 50 dB PSNR ch1: 50 dB' };
    throw new Error('Unexpected command');
  };
  const result = await compareVideoFiles(local, platform, { runner });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'review_required');
  assert.ok(result.comparison.reviewReasons.includes('visual content differs'));
});
