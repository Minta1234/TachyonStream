import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
const exec = promisify(execFile);

export async function cleanVideoMetadata(videoPath, ext = '') {
  const cleanExt = (ext || path.extname(videoPath.replace(/\.part$/i, ''))).toLowerCase();
  const inputStat = await fs.stat(videoPath);
  const enableFastStart = ['.mp4', '.m4v', '.mov'].includes(cleanExt) && inputStat.size <= 512 * 1024 * 1024;
  const temporary = `${videoPath}.${crypto.randomBytes(6).toString('hex')}.clean${cleanExt}`;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-i', videoPath,
    '-map', '0:V',
    '-map', '0:a?',
    '-map', '0:s?',
    '-map_metadata', '-1',
    '-map_metadata:s', '-1',
    '-map_metadata:c', '-1',
    '-map_metadata:p', '-1',
    '-map_chapters', '-1',
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-flags:a', '+bitexact',
    '-c', 'copy',
    ...(enableFastStart ? ['-movflags', '+faststart'] : []),
    '-y',
    temporary
  ];
  try {
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 300000 });
    const stat = await fs.stat(temporary);
    if (!stat.size) throw new Error('Empty cleaned video output');
    await fs.rename(temporary, videoPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function generateMovieThumbnail(videoPath, target) {
  const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { timeout: 30000 });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration');
  const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.jpg`;
  try {
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.min(300, duration * 0.1)), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2', '-threads', '1', '-q:v', '3', '-y', temporary], { timeout: 60000 });
    const stat = await fs.stat(temporary);
    if (!stat.size) throw new Error('Empty thumbnail');
    await fs.rename(temporary, target);
    return duration;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
