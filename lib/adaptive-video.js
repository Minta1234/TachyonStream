import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export class AdaptiveVideoStore {
  constructor(directory) { this.directory = directory; this.jobs = new Map(); this.queue = []; this.running = false; }
  async prepare(source, retry = false) {
    const stat = await fs.stat(source);
    const id = crypto.createHash('sha256').update(`${source}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    const directory = path.join(this.directory, id);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'));
      return {id, status:'ready', levels:metadata.levels};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (retry && this.jobs.get(id)?.status === 'failed') this.jobs.delete(id);
    if (this.jobs.has(id)) return this.jobs.get(id);
    if (this.queue.length >= 4) return {status:'busy'};
    const job = {id, status:'queued'};
    this.jobs.set(id, job);
    this.queue.push({job,source,stat,directory});
    void this.run();
    return job;
  }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const {job,source,stat,directory} = this.queue.shift();
        job.status = 'processing';
        try {
          await fs.mkdir(directory,{recursive:true});
          const {stdout} = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration','-of','json',source], {timeout:30000});
          const probe = JSON.parse(stdout);
          const video = probe.streams?.[0];
          if (!video?.height || !video?.width) throw new Error('No video stream');
          const rotation = Number(video.side_data_list?.find(item=>item.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
          if (Math.abs(rotation) % 180 === 90) [video.width,video.height] = [video.height,video.width];
          const heights = [360,480,720,1080].filter(height => height <= video.height);
          if (!heights.length) heights.push(Math.floor(video.height / 2) * 2);
          const duration = Number(probe.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration');
          const disk = await fs.statfs(directory);
          const expectedBytes = heights.reduce((sum,height)=>sum+(height<=360?828:height<=480?1328:height<=720?2628:4628)*1000*duration/8,0);
          if (disk.bavail*disk.bsize < expectedBytes*1.2 + 512*1024*1024) throw new Error('Insufficient free disk space for quality variants');
          const levels = [];
          for (const height of heights) {
            const bitrate = height <= 360 ? 700 : height <= 480 ? 1200 : height <= 720 ? 2500 : 4500;
            await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-nostdin','-y','-i',source,
              '-map','0:v:0','-map','0:a:0?','-sn','-vf',`scale=-2:${height},fps=30`,'-c:v','libx264','-preset','fast','-threads','2','-filter_threads','1','-pix_fmt','yuv420p',
              '-b:v',`${bitrate}k`,'-maxrate',`${bitrate}k`,'-bufsize',`${bitrate*2}k`,'-g','120','-keyint_min','120','-sc_threshold','0',
              '-c:a','aac','-b:a','96k','-ac','2','-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_flags','independent_segments',
              '-hls_segment_filename',path.join(directory,`${height}p_%06d.ts`),path.join(directory,`${height}p.m3u8`)], {timeout:24*60*60*1000,maxBuffer:1024*1024});
            levels.push({height,width:Math.round(video.width*height/video.height/2)*2,bandwidth:(bitrate+128)*1000});
          }
          const current = await fs.stat(source);
          if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('Source changed during encoding');
          await fs.writeFile(path.join(directory,'master.m3u8'), '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'+levels.map(level=>`#EXT-X-STREAM-INF:BANDWIDTH=${level.bandwidth},RESOLUTION=${level.width}x${level.height}\n${level.height}p.m3u8\n`).join(''));
          await fs.writeFile(path.join(directory,'ready.json'),JSON.stringify({source,size:stat.size,mtimeMs:stat.mtimeMs,levels}));
          Object.assign(job,{status:'ready',levels});
        } catch (error) {
          job.status = 'failed';
          job.error = error.code === 'ENOENT' && error.syscall?.startsWith('spawn')
            ? 'FFmpeg/FFprobe not found. Set FFMPEG_PATH and FFPROBE_PATH, then restart the server.'
            : error.message === 'Insufficient free disk space for quality variants'
            ? 'Not enough free disk space to prepare quality.'
            : error.code === 'EACCES' || error.code === 'EPERM'
            ? 'The server cannot read the video or write the quality cache.'
            : 'Video conversion failed. Check the server log and FFmpeg codec support.';
          console.error('Adaptive encoding failed:', error.code || error.message.split('\n')[0]);
          await fs.rm(directory,{recursive:true,force:true}).catch(error=>console.error('Adaptive cleanup failed:',error.code));
        }
        // Completed manifests live on disk; bound the in-memory job history.
        if (this.jobs.size > 32) for (const [id,entry] of this.jobs) {
          if (entry.status === 'ready' || entry.status === 'failed') { this.jobs.delete(id); break; }
        }
      }
    } finally { this.running = false; }
  }
  async asset(id, name) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^(master|\d+p)\.m3u8$|^\d+p_\d{6}\.ts$/.test(name)) return null;
    const directory = path.join(this.directory,id);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory,'ready.json'),'utf8'));
      const stat = await fs.stat(metadata.source);
      if (stat.size !== metadata.size || stat.mtimeMs !== metadata.mtimeMs) return null;
      return path.join(directory,name);
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }
}
