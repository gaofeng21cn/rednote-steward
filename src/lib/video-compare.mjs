import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function runCommand(command, args, { timeoutMs = 600_000 } = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : null,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error: String(error.message || error).split('\n')[0],
    };
  }
}

function finiteNumber(value, fallback, label, { min = -Infinity, max = Infinity } = {}) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return number;
}

export function parseSsimOutput(stderr) {
  const matches = [...String(stderr).matchAll(/SSIM\s+Y:([0-9.]+).*?All:([0-9.]+)/g)];
  if (!matches.length) return null;
  return {
    y: Number(matches.at(-1)[1]),
    all: Number(matches.at(-1)[2]),
  };
}

export function parsePsnrOutput(stderr) {
  const matches = [...String(stderr).matchAll(
    /PSNR\s+ch0:\s*([0-9.]+)\s*dB.*?PSNR\s+ch1:\s*([0-9.]+)\s*dB/gs,
  )];
  if (!matches.length) return null;
  return {
    channel0: Number(matches.at(-1)[1]),
    channel1: Number(matches.at(-1)[2]),
  };
}

async function probeDuration(file, { ffprobe, runner }) {
  const result = await runner(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) return null;
  const duration = Number(result.stdout.trim());
  return Number.isFinite(duration) ? duration : null;
}

/**
 * Compare local approved bytes with a downloaded platform readback.
 *
 * Visual SSIM covers the full duration at two samples per second after a
 * common 320x180 scale. Audio PSNR and duration provide independent checks.
 * This is deliberately local and read-only: it never submits or edits a post.
 */
export async function compareVideoFiles(localFile, platformFile, options = {}) {
  const localPath = String(localFile || '').trim();
  const platformPath = String(platformFile || '').trim();
  if (!localPath || !platformPath) {
    throw new Error('media-compare requires a local approved video and a platform readback video');
  }
  const ssimThreshold = finiteNumber(options.ssimThreshold, 0.995, 'ssimThreshold', { min: 0, max: 1 });
  const audioPsnrThreshold = finiteNumber(options.audioPsnrThreshold, 30, 'audioPsnrThreshold', { min: 0 });
  const durationTolerance = finiteNumber(options.durationTolerance, 0.25, 'durationTolerance', { min: 0 });
  const ffmpeg = options.ffmpeg || 'ffmpeg';
  const ffprobe = options.ffprobe || 'ffprobe';
  const runner = options.runner || runCommand;
  const hashFile = options.hashFile || sha256File;

  const [localStat, platformStat] = await Promise.all([
    fs.stat(localPath),
    fs.stat(platformPath),
  ]);
  if (!localStat.isFile() || !localStat.size) throw new Error('Approved video must be a nonempty file');
  if (!platformStat.isFile() || !platformStat.size) throw new Error('Platform readback video must be a nonempty file');

  const [localSha256, platformSha256, localDuration, platformDuration] = await Promise.all([
    hashFile(localPath),
    hashFile(platformPath),
    probeDuration(localPath, { ffprobe, runner }),
    probeDuration(platformPath, { ffprobe, runner }),
  ]);

  const visual = await runner(ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i',
    localPath,
    '-i',
    platformPath,
    '-filter_complex',
    '[0:v]fps=2,scale=320:180,setpts=PTS-STARTPTS[v0];'
      + '[1:v]fps=2,scale=320:180,setpts=PTS-STARTPTS[v1];[v0][v1]ssim',
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const audio = await runner(ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i',
    localPath,
    '-i',
    platformPath,
    '-filter_complex',
    '[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];'
      + '[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];[a0][a1]apsnr',
    '-vn',
    '-f',
    'null',
    '-',
  ]);

  const ssim = visual.exitCode === 0 ? parseSsimOutput(visual.stderr) : null;
  const psnr = audio.exitCode === 0 ? parsePsnrOutput(audio.stderr) : null;
  const durationDelta = localDuration != null && platformDuration != null
    ? Math.abs(localDuration - platformDuration)
    : null;
  const reasons = [];
  if (!ssim) reasons.push('visual comparison unavailable');
  else if (ssim.all < ssimThreshold) reasons.push('visual content differs');
  if (!psnr) reasons.push('audio comparison unavailable');
  else if (Math.min(psnr.channel0, psnr.channel1) < audioPsnrThreshold) {
    reasons.push('audio content differs');
  }
  if (durationDelta == null) reasons.push('duration comparison unavailable');
  else if (durationDelta > durationTolerance) reasons.push('duration differs');

  return {
    ok: reasons.length === 0,
    status: reasons.length === 0 ? 'match' : 'review_required',
    local: {
      path: localPath,
      bytes: localStat.size,
      sha256: localSha256,
      durationSeconds: localDuration,
    },
    platform: {
      path: platformPath,
      bytes: platformStat.size,
      sha256: platformSha256,
      durationSeconds: platformDuration,
    },
    byteIdentical: localSha256 === platformSha256,
    comparison: {
      visualSsim: ssim?.all ?? null,
      visualSsimY: ssim?.y ?? null,
      audioPsnrDb: psnr
        ? Math.min(psnr.channel0, psnr.channel1)
        : null,
      durationDeltaSeconds: durationDelta,
      reviewReasons: reasons,
      method: 'full-duration video SSIM sampled at 2 fps after 320x180 scaling; normalized stereo audio PSNR at 48 kHz; duration check',
      limits: 'Content comparison does not prove platform review, visibility or audience reception.',
    },
    thresholds: {
      visualSsim: ssimThreshold,
      audioPsnrDb: audioPsnrThreshold,
      durationDeltaSeconds: durationTolerance,
    },
    toolExitCodes: {
      visual: visual.exitCode,
      audio: audio.exitCode,
    },
  };
}
