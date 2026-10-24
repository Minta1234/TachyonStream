import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateMovieThumbnail } from '../lib/thumbnails.js';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploads = path.join(root, 'public', 'uploads');
const thumbnails = path.join(root, 'public', 'thumbnails');
const metadataPath = path.join(thumbnails, 'metadata.json');
await fs.mkdir(thumbnails, { recursive: true });
let metadata = {};
try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
let generated = 0, failed = 0, skipped = 0;
async function scan(dir, relative = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scan(full, rel); continue; }
    if (!entry.isFile() || !/\.(mp4|webm|mkv|mov|ogg|ogv|avi|flv|wmv|m4v)$/i.test(entry.name)) continue;
    const hash = crypto.createHash('sha1').update(rel).digest('hex');
    const target = path.join(thumbnails, `${hash}.jpg`);
    try { await fs.access(target); if (!process.argv.includes('--refresh')) { skipped++; continue; } } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try {
      const duration = await generateMovieThumbnail(full, target);
      metadata[hash] = { duration };
      generated++;
      console.log(`Generated ${generated}: ${rel}`);
    } catch (err) { failed++; console.error(`Failed ${rel}: ${err.message}`); }
  }
}
await scan(uploads);
await fs.writeFile(metadataPath + '.tmp', JSON.stringify(metadata, null, 2));
for (let attempt = 0; ; attempt++) {
  try { await fs.rename(metadataPath + '.tmp', metadataPath); break; }
  catch (err) {
    if (err.code !== 'EPERM' || attempt >= 3) throw err;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
console.log(JSON.stringify({ generated, skipped, failed }));
if (failed) process.exitCode = 1;
