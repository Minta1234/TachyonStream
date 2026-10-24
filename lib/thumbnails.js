import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
const exec = promisify(execFile);

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
