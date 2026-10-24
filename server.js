import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";
import { pipeline } from "node:stream/promises";
import { generateMovieThumbnail } from "./lib/thumbnails.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
function isTrustedRequest(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] === "same-origin";
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.host === req.headers.host;
  } catch { return false; }
}
const io = new Server(server, {
  allowRequest: (req, callback) => callback(null, isTrustedRequest(req))
});
const PORT = process.env.PORT || 9815;
const dataDir = process.env.DATA_DIR || path.join(__dirname, "public");
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return next();
  if (!isTrustedRequest(req)) return res.status(403).json({ error: "Cross-site requests are not allowed" });
  const sid = req.headers["x-playback-session"];
  if (typeof sid !== "string" || !io.sockets.sockets.has(sid)) return res.status(401).json({ error: "Open the player and wait for connection before trying again" });
  next();
});

// Directories
const uploadsDir = path.join(dataDir, "uploads");
const tempChunksDir = path.join(dataDir, "temp_chunks");
const thumbnailsDir = path.join(dataDir, "thumbnails");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(tempChunksDir)) fs.mkdirSync(tempChunksDir, { recursive: true });
if (!fs.existsSync(thumbnailsDir)) fs.mkdirSync(thumbnailsDir, { recursive: true });

// Persistent thumbnail metadata (durations, timestamps)
const thumbnailMetaFile = path.join(thumbnailsDir, "metadata.json");
let thumbnailMetadata = {};
try {
  if (fs.existsSync(thumbnailMetaFile)) {
    thumbnailMetadata = JSON.parse(fs.readFileSync(thumbnailMetaFile, "utf-8"));
  }
} catch {
  thumbnailMetadata = {};
}

function saveThumbnailMetadata() {
  try {
    fs.writeFileSync(thumbnailMetaFile, JSON.stringify(thumbnailMetadata, null, 2), "utf-8");
  } catch (err) { console.error("Thumbnail metadata save failed:", err.message); }
}

// ==========================================================================
// Security & Path Confinement Defenses
// ==========================================================================
function isPathInside(allowedBaseDir, targetPath) {
  if (!targetPath) return false;
  const rel = path.relative(allowedBaseDir, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveSafePath(baseDir, userInput) {
  if (!userInput || typeof userInput !== "string") return null;
  const decoded = userInput;
  const normalized = path.normalize(decoded);
  const resolved = path.join(baseDir, normalized);
  if (!isPathInside(baseDir, resolved)) {
    return null; // Deny Path Traversal
  }
  return resolved;
}

function sanitizeUploadId(id) {
  if (!id || typeof id !== "string") return null;
  // Strict regex: must contain ONLY alphanumeric, underscores, or hyphens (4-64 chars)
  if (!/^[a-zA-Z0-9_\-]{4,64}$/.test(id)) {
    return null;
  }
  return id;
}

function sanitizeRoomId(id) {
  if (!id || typeof id !== "string") return "default-voice-room";
  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(id) || id === "__proto__" || id === "constructor" || id === "prototype") {
    return "default-voice-room";
  }
  return id;
}

// Raw body parser for binary chunks
app.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));
app.use(express.json());

// Allowed video formats for movie streaming
// Note: .ts is excluded because HTML5 browsers cannot play raw MPEG-TS directly, and .ts collides with TypeScript source files.
const ALLOWED_VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".wmv", ".m4v", ".ogv", ".ogg"
]);

function inspectVideoHeader(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, reason: "Empty chunk content" };
  }
  const ext = path.extname(filename || "").toLowerCase();

  // Explicit handling for .ts (TypeScript vs MPEG-TS Movie)
  if (ext === ".ts") {
    const isMpegTs = buffer[0] === 0x47 && (buffer.length < 188 || buffer[188] === 0x47);
    if (isMpegTs) {
      return {
        valid: false,
        reason: "Detected as MPEG Transport Stream (.ts). HTML5 browsers cannot play raw .ts files directly. Please convert to MP4, MKV, or WebM."
      };
    }
    return {
      valid: false,
      reason: "Detected as TypeScript source code (.ts). TachyonStream only accepts movie/video files."
    };
  }

  // Check if buffer is predominantly printable ASCII/text (e.g. source code disguised as a movie)
  if (buffer.length >= 16) {
    let asciiCount = 0;
    const sampleSize = Math.min(buffer.length, 512);
    for (let i = 0; i < sampleSize; i++) {
      const b = buffer[i];
      if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) asciiCount++;
    }
    if (asciiCount / sampleSize > 0.88) {
      return {
        valid: false,
        reason: `File "${filename}" appears to be plain text or source code, not a valid video stream.`
      };
    }
  }

  return { valid: true };
}

function isAllowedVideoFile(filename) {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.has(ext);
}

// Chunk Upload API
app.post("/api/upload-chunk", (req, res) => {
  const { uploadId, chunkIndex, fileName } = req.query;
  const cleanUploadId = sanitizeUploadId(uploadId);
  const cleanChunkIndex = typeof chunkIndex === "string" && /^\d+$/.test(chunkIndex) ? Number(chunkIndex) : NaN;

  if (!cleanUploadId || !Number.isSafeInteger(cleanChunkIndex) || cleanChunkIndex < 0 || (fileName !== undefined && typeof fileName !== "string")) {
    return res.status(400).json({ error: "Invalid uploadId or chunkIndex" });
  }

  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: "Missing binary chunk data" });
  }

  if (fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
      const headerCheck = inspectVideoHeader(req.body, fileName);
      return res.status(400).json({
        error: `Upload rejected: ${headerCheck.reason || `"${fileName}" is not an accepted movie file.`}`
      });
    }

    if (cleanChunkIndex === 0) {
      const headerCheck = inspectVideoHeader(req.body, fileName);
      if (!headerCheck.valid) {
        return res.status(400).json({
          error: `Upload rejected: ${headerCheck.reason}`
        });
      }
    }
  }

  const chunkFolder = path.join(tempChunksDir, cleanUploadId);
  if (!isPathInside(tempChunksDir, chunkFolder)) {
    return res.status(403).json({ error: "Forbidden: upload path traversal detected" });
  }

  if (!fs.existsSync(chunkFolder)) {
    fs.mkdirSync(chunkFolder, { recursive: true });
  }

  const chunkPath = path.join(chunkFolder, `chunk_${cleanChunkIndex}`);
  fs.writeFile(chunkPath, req.body, (err) => {
    if (err) {
      console.error("Chunk write error:", err);
      return res.status(500).json({ error: "Failed to write chunk" });
    }
    res.json({ success: true, chunkIndex: cleanChunkIndex });
  });
});

// Finalize Chunk Upload and Assemble (supports folder destination)
app.post("/api/complete-upload", (req, res, next) => {
  (async () => {
  const { uploadId, fileName, totalChunks, folder } = req.body;
  const cleanUploadId = sanitizeUploadId(uploadId);
  const cleanTotalChunks = totalChunks;

  if (!cleanUploadId || typeof fileName !== "string" || !fileName || !Number.isSafeInteger(cleanTotalChunks) || cleanTotalChunks <= 0 || cleanTotalChunks > 100000) {
    return res.status(400).json({ error: "Missing or invalid required parameters" });
  }

  const chunkFolder = path.join(tempChunksDir, cleanUploadId);
  if (!isPathInside(tempChunksDir, chunkFolder)) {
    return res.status(403).json({ error: "Forbidden: upload path traversal detected" });
  }

  const ext = path.extname(fileName).toLowerCase();

  // Strict Movie File Validation
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    if (fs.existsSync(chunkFolder)) {
      fs.rmSync(chunkFolder, { recursive: true, force: true });
    }
    let reason = `"${fileName}" is not a recognized movie file. Allowed formats: MP4, MKV, WebM, MOV, AVI.`;
    if (ext === ".ts") {
      reason = `".ts" files are ambiguous (TypeScript code / raw MPEG-TS). TachyonStream requires MP4, MKV, or WebM for browser playback.`;
    }
    console.warn(`[REJECTED UPLOAD] ${fileName} rejected: ${reason}`);
    return res.status(400).json({
      error: `Upload rejected: ${reason}`
    });
  }

  // Inspect chunk_0 header before assembling
  const chunk0Path = path.join(chunkFolder, "chunk_0");
  if (fs.existsSync(chunk0Path)) {
    const chunk0Data = fs.readFileSync(chunk0Path);
    const headerCheck = inspectVideoHeader(chunk0Data, fileName);
    if (!headerCheck.valid) {
      fs.rmSync(chunkFolder, { recursive: true, force: true });
      return res.status(400).json({
        error: `Upload rejected: ${headerCheck.reason}`
      });
    }
  }
  const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_\-\u0E00-\u0E7F]/g, "_").substring(0, 30);
  const randomId = crypto.randomBytes(8).toString("hex");
  const uniqueName = `${baseName}_${randomId}${ext}`;

  let targetDir = uploadsDir;
  let cleanTargetFolder = "";
  if (folder && typeof folder === "string" && folder.trim()) {
    const safeTarget = resolveSafePath(uploadsDir, folder.trim());
    if (!safeTarget) {
      return res.status(403).json({ error: "Forbidden: invalid folder destination" });
    }
    targetDir = safeTarget;
    cleanTargetFolder = path.relative(uploadsDir, targetDir);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  const finalFilePath = path.join(targetDir, uniqueName);
  try {
    // Validate before writing; publish only after the entire assembly succeeds.
    for (let i = 0; i < cleanTotalChunks; i++) {
      await fs.promises.access(path.join(chunkFolder, `chunk_${i}`));
    }
    async function* chunks() {
      for (let i = 0; i < cleanTotalChunks; i++) {
        yield* fs.createReadStream(path.join(chunkFolder, `chunk_${i}`));
      }
    }
    await pipeline(chunks(), fs.createWriteStream(finalFilePath + ".part", { flags: "wx" }));
    await fs.promises.rename(finalFilePath + ".part", finalFilePath);

    const videoRelativePath = path.relative(uploadsDir, finalFilePath).replace(/\\/g, "/");
    const thumbHash = crypto.createHash("sha1").update(videoRelativePath).digest("hex");
    try {
      const duration = await generateMovieThumbnail(finalFilePath, path.join(thumbnailsDir, `${thumbHash}.jpg`));
      thumbnailMetadata[thumbHash] = { duration };
      saveThumbnailMetadata();
    } catch (err) {
      // Keep a valid upload even when the optional decoder is unavailable.
      console.warn("Automatic thumbnail failed:", videoRelativePath, err.message);
    }

    // Clean up temporary chunks folder
    fs.rmSync(chunkFolder, { recursive: true, force: true });

    let relFolder = "";
    if (cleanTargetFolder) {
      relFolder = cleanTargetFolder.replace(/\\/g, "/");
    }

    const fileUrl = relFolder
      ? `/api/stream/${relFolder.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/${encodeURIComponent(uniqueName)}`
      : `/api/stream/${encodeURIComponent(uniqueName)}`;

    io.emit("library-updated");

    res.json({
      url: fileUrl,
      filename: uniqueName,
      folder: relFolder || null,
      originalName: fileName
    });
  } catch (err) {
    await fs.promises.unlink(finalFilePath + ".part").catch(error => {
      if (error.code !== "ENOENT") console.error("Partial upload cleanup failed:", error);
    });
    console.error("Assembly error:", err);
    res.status(500).json({ error: "Failed to assemble file chunks: " + err.message });
  }
  })().catch(next);
});

// Recursive directory scanner for unlimited nested folders
function scanLibraryDirectory(dirPath, relativePath = "") {
  const isVideo = isAllowedVideoFile;
  const naturalSort = (a, b) => (a.name || a.path || a).localeCompare((b.name || b.path || b), undefined, { numeric: true, sensitivity: "base" });

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { subfolders: [], videos: [] };
  }

  const subfolders = [];
  const videos = [];

  entries.forEach(entry => {
    const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const childData = scanLibraryDirectory(fullPath, entryRelPath);
      const totalVideos = childData.videos.length + childData.subfolders.reduce((acc, sf) => acc + (sf.totalVideos || 0), 0);

      // First video in folder or subfolders for poster
      const firstVidThumb = childData.videos.find(v => v.thumbnailUrl)?.thumbnailUrl
        || childData.subfolders.find(sf => sf.thumbnailUrl)?.thumbnailUrl
        || null;
      subfolders.push({
        name: entry.name,
        path: entryRelPath,
        parent: relativePath || null,
        subfolders: childData.subfolders,
        videos: childData.videos,
        totalVideos,
        thumbnailUrl: firstVidThumb
      });
    } else if (entry.isFile() && isVideo(entry.name)) {
      const thumbHash = crypto.createHash("sha1").update(entryRelPath).digest("hex");
      const thumbFile = path.join(thumbnailsDir, `${thumbHash}.jpg`);
      const hasThumb = fs.existsSync(thumbFile);
      const meta = thumbnailMetadata[thumbHash] || null;

      videos.push({
        name: entry.name,
        folder: relativePath || null,
        path: entryRelPath,
        url: `/api/stream/${entryRelPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`,
        thumbnailUrl: hasThumb ? `/thumbnails/${thumbHash}.jpg?v=${fs.statSync(thumbFile).mtimeMs}` : null,
        duration: meta ? meta.duration : null
      });
    }
  });

  subfolders.sort(naturalSort);
  videos.sort(naturalSort);

  return { subfolders, videos };
}

// Flatten folder tree for easy dropdown selectors
function flattenFolders(folders, depth = 0) {
  let list = [];
  folders.forEach(f => {
    list.push({
      name: f.name,
      path: f.path,
      depth,
      totalVideos: f.totalVideos
    });
    if (f.subfolders && f.subfolders.length > 0) {
      list = list.concat(flattenFolders(f.subfolders, depth + 1));
    }
  });
  return list;
}

// Detailed structured library endpoint (nested folders + root videos)
app.get("/api/library", (req, res) => {
  try {
    const { subfolders, videos } = scanLibraryDirectory(uploadsDir);
    const allFoldersList = flattenFolders(subfolders);

    res.json({
      folders: subfolders,
      rootVideos: videos,
      allFoldersList
    });
  } catch (err) {
    console.error("Library read error:", err);
    res.status(500).json({ error: "Could not load library: " + err.message });
  }
});

// Flat list of all uploaded videos for compatibility
app.get("/api/videos", (req, res) => {
  try {
    const isVideo = isAllowedVideoFile;
    const all = [];

    function collectVideos(dir, rel = "") {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach(entry => {
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectVideos(full, entryRel);
          } else if (entry.isFile() && isVideo(entry.name)) {
            all.push({
              name: entry.name,
              folder: rel || null,
              path: entryRel,
              url: `/api/stream/${entryRel.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`
            });
          }
        });
      } catch {}
    }

    collectVideos(uploadsDir);
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: "Could not list files" });
  }
});

// Create new folder (supports creating subfolders inside any parent folder)
app.post("/api/folders", (req, res) => {
  if (typeof req.body?.name !== "string" || (req.body.parent != null && typeof req.body.parent !== "string")) return res.status(400).json({ error: "Invalid folder parameters" });
  const rawName = req.body.name.trim();
  const rawParent = (req.body.parent || "").trim();

  const cleanName = rawName.replace(/[\\/:*?"<>|]/g, "_").substring(0, 60);
  if (!cleanName) {
    return res.status(400).json({ error: "Folder name cannot be empty" });
  }

  let folderRelPath = cleanName;
  if (rawParent) {
    const safeParent = resolveSafePath(uploadsDir, rawParent);
    if (!safeParent) {
      return res.status(403).json({ error: "Access denied: Invalid parent folder" });
    }
    folderRelPath = path.relative(uploadsDir, path.join(safeParent, cleanName));
  }

  const targetDir = path.join(uploadsDir, folderRelPath);
  if (!isPathInside(uploadsDir, targetDir)) {
    return res.status(403).json({ error: "Access denied: Path traversal detected" });
  }

  if (fs.existsSync(targetDir)) {
    return res.status(400).json({ error: "A folder with this name already exists" });
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const unifiedRelPath = folderRelPath.replace(/\\/g, "/");
    console.log(`📁 Created folder: ${unifiedRelPath}`);
    io.emit("library-updated");
    res.json({ success: true, folder: unifiedRelPath });
  } catch (err) {
    res.status(500).json({ error: "Failed to create folder: " + err.message });
  }
});

// Delete folder endpoint (supports nested subfolder paths)
app.delete(["/api/folders/*", "/api/folders/:folderName"], (req, res) => {
  const relPath = req.params[0] !== undefined ? req.params[0] : req.params.folderName;
  const targetDir = resolveSafePath(uploadsDir, relPath);

  if (!targetDir || !isPathInside(uploadsDir, targetDir) || targetDir === uploadsDir) {
    return res.status(403).json({ error: "Access denied: Invalid folder path" });
  }
  const safeRelPath = path.relative(uploadsDir, targetDir);

  if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
    try {
      // If any room is playing a video from this folder or its subfolders, reset room playback
      const folderUrlToken = safeRelPath.replace(/\\/g, "/");
      Object.keys(roomStates).forEach(roomId => {
        const src = roomStates[roomId]?.source || "";
        let decodedSrc = "";
        try { decodedSrc = decodeURIComponent(src); } catch {}
        if (decodedSrc.split("?")[0].startsWith(`/api/stream/${folderUrlToken}/`)) {
          roomStates[roomId] = {
            source: "",
            isPlaying: false,
            currentTime: 0,
            lastUpdated: Date.now(),
            autoNext: false,
            currentFolder: null
          };
          io.to(roomId).emit("change-source", { source: "", folder: null });
        }
      });

      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(`🗑️ Deleted folder: ${safeRelPath}`);
      io.emit("library-updated");
      res.json({ success: true, deleted: safeRelPath });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete folder: " + e.message });
    }
  } else {
    res.status(404).json({ error: "Folder not found" });
  }
});

// Move video to/from folder endpoint (supports moving to any nested folder or root)
app.post("/api/move-video", (req, res) => {
  const { videoPath, targetFolder } = req.body;
  if (!videoPath) {
    return res.status(400).json({ error: "Missing videoPath" });
  }

  const sourcePath = resolveSafePath(uploadsDir, videoPath);
  if (!sourcePath || !fs.existsSync(sourcePath) || fs.statSync(sourcePath).isDirectory()) {
    return res.status(404).json({ error: "Source video not found" });
  }

  const fileName = path.basename(sourcePath);
  let destDir = uploadsDir;
  let cleanTargetFolder = "";

  if (targetFolder && typeof targetFolder === "string" && targetFolder.trim()) {
    const safeDest = resolveSafePath(uploadsDir, targetFolder.trim());
    if (!safeDest) {
      return res.status(403).json({ error: "Access denied: Invalid destination folder" });
    }
    destDir = safeDest;
    cleanTargetFolder = path.relative(uploadsDir, destDir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
  }

  const destPath = path.join(destDir, fileName);
  if (!isPathInside(uploadsDir, destPath)) {
    return res.status(403).json({ error: "Access denied: Path traversal detected" });
  }

  if (sourcePath !== destPath && fs.existsSync(destPath)) return res.status(409).json({ error: "Destination file already exists" });
  try {
    fs.renameSync(sourcePath, destPath);
    console.log(`📦 Moved video ${fileName} -> ${cleanTargetFolder || "Root"}`);
    const oldHash = crypto.createHash("sha1").update(path.relative(uploadsDir, sourcePath).replace(/\\/g, "/")).digest("hex");
    const newHash = crypto.createHash("sha1").update(path.relative(uploadsDir, destPath).replace(/\\/g, "/")).digest("hex");
    if (oldHash !== newHash && fs.existsSync(path.join(thumbnailsDir, `${oldHash}.jpg`))) {
      try {
        fs.copyFileSync(path.join(thumbnailsDir, `${oldHash}.jpg`), path.join(thumbnailsDir, `${newHash}.jpg`));
        if (thumbnailMetadata[oldHash]) thumbnailMetadata[newHash] = thumbnailMetadata[oldHash];
        saveThumbnailMetadata();
      } catch (err) { console.warn("Could not move thumbnail:", err.message); }
    }

    const newRelFolder = cleanTargetFolder ? cleanTargetFolder.replace(/\\/g, "/") : "";
    const newUrl = newRelFolder
      ? `/api/stream/${newRelFolder.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/${encodeURIComponent(fileName)}`
      : `/api/stream/${encodeURIComponent(fileName)}`;

    // Update active room source if playing this video
    Object.keys(roomStates).forEach(roomId => {
      const src = roomStates[roomId]?.source || "";
      let decodedSrc = "";
      try { decodedSrc = decodeURIComponent(src); } catch {}
      if (decodedSrc.split("?")[0] === `/api/stream/${path.relative(uploadsDir, sourcePath).replace(/\\/g, "/")}`) {
        roomStates[roomId].source = newUrl;
        roomStates[roomId].currentFolder = newRelFolder || null;
        io.to(roomId).emit("change-source", { source: newUrl, folder: newRelFolder || null });
      }
    });

    io.emit("library-updated");
    res.json({ success: true, newUrl, folder: newRelFolder || null });
  } catch (e) {
    res.status(500).json({ error: "Failed to move video: " + e.message });
  }
});

// Delete specific video endpoint (supports any nested folder depth)
app.delete(["/api/videos/*", "/api/videos/:filename"], (req, res) => {
  const relPath = req.params[0] !== undefined ? req.params[0] : req.params.filename;
  const filePath = resolveSafePath(uploadsDir, relPath);

  if (!filePath || !isPathInside(uploadsDir, filePath)) {
    return res.status(403).json({ error: "Access denied: Invalid file path" });
  }
  const cleanPath = path.relative(uploadsDir, filePath);
  const fileName = path.basename(filePath);

  if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
    try {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Manually deleted: ${cleanPath}`);

      // If any room is currently playing this deleted video, reset it
      Object.keys(roomStates).forEach(roomId => {
        const currentSrc = roomStates[roomId]?.source || "";
        let decodedSrc = "";
        try { decodedSrc = decodeURIComponent(currentSrc); } catch {}
        if (decodedSrc.split("?")[0] === `/api/stream/${cleanPath.replace(/\\/g, "/")}`) {
          roomStates[roomId] = {
            source: "",
            isPlaying: false,
            currentTime: 0,
            lastUpdated: Date.now(),
            autoNext: roomStates[roomId]?.autoNext || false,
            currentFolder: null
          };
          io.to(roomId).emit("change-source", { source: "", folder: null });
        }
      });

      io.emit("library-updated");
      io.emit("video-deleted", { filename: fileName });
      res.json({ success: true, deleted: cleanPath });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete: " + e.message });
    }
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

// Save client-captured video thumbnail snapshot to persistent disk storage
app.post("/api/save-thumbnail", (req, res) => {
  try {
    const sid = req.headers["x-playback-session"];
    if (!io.sockets.sockets.has(sid)) return res.status(401).json({ error: "Active playback session required" });
    const { videoPath, dataUrl, duration } = req.body;
    const videoFile = resolveSafePath(uploadsDir, videoPath);
    if (!videoFile || !fs.existsSync(videoFile) || !fs.statSync(videoFile).isFile() || !isAllowedVideoFile(videoFile)) return res.status(400).json({ error: "Invalid video path" });
    if (typeof dataUrl !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 120000) return res.status(400).json({ error: "Invalid JPEG thumbnail" });
    if (!videoPath || !dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const thumbHash = crypto.createHash("sha1").update(videoPath).digest("hex");
    const thumbPath = path.join(thumbnailsDir, `${thumbHash}.jpg`);
    fs.writeFileSync(thumbPath, buffer);

    if (typeof duration === "number" && duration > 0) {
      thumbnailMetadata[thumbHash] = { duration };
      saveThumbnailMetadata();
    }

    console.log(`🖼️ Saved thumbnail for: ${videoPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
    res.json({
      success: true,
      thumbnailUrl: `/thumbnails/${thumbHash}.jpg`,
      duration: thumbnailMetadata[thumbHash]?.duration || null
    });
  } catch (err) {
    console.error("Failed to save thumbnail:", err);
    res.status(500).json({ error: "Failed to save thumbnail: " + err.message });
  }
});

// Active stream playback tokens / socket session tracker
const activePlaybackSessions = new Map();

// Validate that video request originates from an authorized TachyonStream player session
function validateVideoAccess(req) {
  const secFetchDest = req.headers["sec-fetch-dest"];
  const secFetchMode = req.headers["sec-fetch-mode"];
  const secFetchUser = req.headers["sec-fetch-user"];
  const acceptHeader = req.headers["accept"] || "";
  const referer = req.headers["referer"] || "";
  const sid = req.query.sid;

  // 1. Direct browser address bar navigation (typing raw URL directly or opening in a new tab)
  // Browsers ALWAYS send sec-fetch-mode: navigate or sec-fetch-user: ?1 or sec-fetch-dest: document on top-level navigation!
  if (secFetchMode === "navigate" || secFetchUser === "?1" || secFetchDest === "document") {
    return { allowed: false, reason: "Direct video URL access in browser address bar or new tab is forbidden." };
  }

  // 2. Direct browser navigation requesting HTML document
  if (acceptHeader.includes("text/html")) {
    return { allowed: false, reason: "Direct video file requests are prohibited. Access only permitted via TachyonStream Player." };
  }

  // 3. Mandatory Authorized Origin (Referer Header)
  // Legitimate playback from TachyonStream Player or Discord Activity ALWAYS includes a valid Referer.
  // Direct address-bar visits in standalone browser tabs NEVER provide a Referer.
  if (!referer) {
    return { allowed: false, reason: "Direct video URL access in browser address bar is forbidden." };
  }

  try {
    const parsedReferer = new URL(referer);
    const host = parsedReferer.hostname.toLowerCase();
    const customDomain = (process.env.STREAM_DOMAIN || process.env.ALLOWED_DOMAIN || "").trim().toLowerCase();
    const isAllowedHost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      (customDomain && (host === customDomain || host.endsWith("." + customDomain))) ||
      host === "discord.com" ||
      host.endsWith(".discord.com") ||
      host.endsWith(".discordsays.com");

    if (!isAllowedHost) {
      return { allowed: false, reason: `Hotlinking from unauthorized origin "${host}" is prohibited.` };
    }
  } catch {
    return { allowed: false, reason: "Malformed referer header." };
  }

  // 4. Player session verification (Socket.IO ID)
  // Direct address-bar visits in browser tabs are already permanently blocked by checks 1, 2, 3 above.
  if (sid && typeof sid === "string") {
    const isSocketAlive = io.sockets.sockets.has(sid);
    const sessionTime = activePlaybackSessions.get(sid);
    const isGraceValid = sessionTime && (Date.now() - sessionTime < 180000); // 3 minutes grace period
    if (!isSocketAlive && !isGraceValid) {
      return { allowed: false, reason: "Invalid or expired playback session. Access only permitted via TachyonStream Player." };
    }
    activePlaybackSessions.set(sid, Date.now());
  } else {
    return { allowed: false, reason: "Active player session required." };
  }

  return { allowed: true };
}

// Custom streaming handler for large videos (HTTP 206 Partial Content Range)
// Supports any nested folder depth & Direct URL Access Denied protection
function handleVideoStreaming(req, res) {
  // Direct URL Access Denied Protection: Block unauthorized address-bar visits
  const access = validateVideoAccess(req);
  if (!access.allowed) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>403 Forbidden - Access Denied</title>
        <style>
          * { box-sizing: border-box; }
          body {
            background: #090a0f;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
          }
          .access-card {
            background: #14161f;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 20px;
            padding: 40px 32px;
            text-align: center;
            max-width: 460px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
          }
          .icon { font-size: 3rem; margin-bottom: 12px; }
          h1 {
            font-size: 1.8rem;
            margin: 0 0 10px;
            color: #ff334b;
            font-weight: 800;
            letter-spacing: -0.02em;
          }
          p {
            color: #9da1b2;
            font-size: 0.95rem;
            line-height: 1.6;
            margin: 0 0 28px;
          }
          .btn-home {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #fff;
            color: #000;
            font-weight: 700;
            font-size: 0.95rem;
            padding: 12px 28px;
            border-radius: 99px;
            text-decoration: none;
            box-shadow: 0 4px 18px rgba(255, 255, 255, 0.25);
            transition: transform 0.2s, background 0.2s;
          }
          .btn-home:hover {
            transform: scale(1.04);
            background: #f0f0f0;
          }
        </style>
      </head>
      <body>
        <div class="access-card">
          <div class="icon">🚫</div>
          <h1>Access Denied</h1>
          <p>Direct video URL access is forbidden.<br>Movie streaming is only permitted through the official <strong>TachyonStream</strong> player.</p>
          <a href="/" class="btn-home">▶ Open TachyonStream Player</a>
        </div>
      </body>
      </html>
    `);
  }

  // Normalize path and extract subpath
  const normPath = req.path.replace(/\/+/g, "/");
  const rawSubPath = normPath.replace(/^\/(?:api\/stream|uploads)\/?/, "");

  let decodedSubPath = "";
  try {
    decodedSubPath = decodeURIComponent(rawSubPath);
  } catch {
    decodedSubPath = rawSubPath;
  }

  const filePath = resolveSafePath(uploadsDir, decodedSubPath);

  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return res.status(404).send("File not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const ext = path.extname(filePath).toLowerCase();
  let contentType = "video/mp4";
  if (ext === ".webm") contentType = "video/webm";
  else if (ext === ".mkv") contentType = "video/x-matroska";
  else if (ext === ".mov") contentType = "video/quicktime";
  else if (ext === ".ogg") contentType = "video/ogg";

  // Balanced chunk streaming: max 3MB per partial range request
  // Prevents piping gigabytes of video into RAM on open range requests, ensuring fast seeks and low memory footprint.
  const MAX_STREAM_CHUNK = 3 * 1024 * 1024; // 3 MB

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : start + MAX_STREAM_CHUNK - 1;
    if (end >= fileSize) end = fileSize - 1;

    // Safety check for invalid or reversed ranges
    if (!/^bytes=\d+-\d*$/.test(range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).send("Requested Range Not Satisfiable");
    }

    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    // Clean up read stream if user seeks or aborts
    res.on("close", () => {
      file.destroy();
    });

    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store"
    };
    res.writeHead(206, head);
    file.on("error", err => { console.error("Stream error:", err); res.destroy(); });
    file.pipe(res);
  } else {
    // Non-range request: stream first slice or full
    const head = {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store"
    };
    res.writeHead(200, head);
    const file = fs.createReadStream(filePath);
    res.on("close", () => {
      file.destroy();
    });
    file.on("error", err => { console.error("Stream error:", err); res.destroy(); });
    file.pipe(res);
  }
}

// 1. Permanently and unconditionally BLOCK all direct access to /uploads
app.use((req, res, next) => {
  const norm = req.path.replace(/\/+/g, "/");
  if (norm === "/uploads" || norm.startsWith("/uploads/")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>403 Forbidden - Access Denied</title>
        <style>
          * { box-sizing: border-box; }
          body {
            background: #090a0f;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
          }
          .access-card {
            background: #14161f;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 20px;
            padding: 40px 32px;
            text-align: center;
            max-width: 460px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
          }
          .icon { font-size: 3rem; margin-bottom: 12px; }
          h1 {
            font-size: 1.8rem;
            margin: 0 0 10px;
            color: #ff334b;
            font-weight: 800;
            letter-spacing: -0.02em;
          }
          p {
            color: #9da1b2;
            font-size: 0.95rem;
            line-height: 1.6;
            margin: 0 0 28px;
          }
          .btn-home {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #fff;
            color: #000;
            font-weight: 700;
            font-size: 0.95rem;
            padding: 12px 28px;
            border-radius: 99px;
            text-decoration: none;
            box-shadow: 0 4px 18px rgba(255, 255, 255, 0.25);
            transition: transform 0.2s, background 0.2s;
          }
          .btn-home:hover {
            transform: scale(1.04);
            background: #f0f0f0;
          }
        </style>
      </head>
      <body>
        <div class="access-card">
          <div class="icon">🚫</div>
          <h1>Access Denied</h1>
          <p>Direct video URL access is forbidden.<br>Movie streaming is only permitted through the official <strong>TachyonStream</strong> player.</p>
          <a href="/" class="btn-home">▶ Open TachyonStream Player</a>
        </div>
      </body>
      </html>
    `);
  }
  next();
});

// 2. Secure streaming endpoint for TachyonStream player (requires active socket session & referer)
app.use((req, res, next) => {
  const norm = req.path.replace(/\/+/g, "/");
  if (norm === "/api/stream" || norm.startsWith("/api/stream/")) {
    return handleVideoStreaming(req, res);
  }
  next();
});

// Production-grade persistent thumbnail cache (7 days client & CDN caching for immutable hash images)
app.use("/thumbnails", express.static(thumbnailsDir, {
  maxAge: "7d",
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  }
}));

app.use("/temp_chunks", (_req, res) => res.sendStatus(403));

// Serve only frontend assets; uploaded files never pass through express.static.
app.get(["/", "/index.html", "/app.js", "/style.css"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const filename = req.path === "/" ? "index.html" : path.basename(req.path).toLowerCase();
  res.sendFile(path.join(__dirname, "public", filename));
});
app.use("/vendor", express.static(path.join(__dirname, "public", "vendor")));

// Room playback state (Prototype-pollution safe dictionary)
const roomStates = Object.create(null);

io.on("connection", (socket) => {
  let currentRoom = null;
  socket.use(([event, payload], next) => {
    const objects = ["join-room", "video-progress", "video-play", "video-pause", "video-seek", "change-source", "set-auto-next"];
    if (objects.includes(event) && (!payload || typeof payload !== "object" || Array.isArray(payload))) return;
    if (["video-progress", "video-play", "video-pause", "video-seek"].includes(event) && (!Number.isFinite(payload.time) || payload.time < 0)) return;
    if (event === "change-source" && (typeof payload.source !== "string" || !payload.source.startsWith("/api/stream/") || payload.source.length > 4096)) return;
    if (["change-source", "set-auto-next"].includes(event) && payload.folder != null && typeof payload.folder !== "string") return;
    next();
  });
  activePlaybackSessions.set(socket.id, Date.now());

  function getLiveRoomState(roomId) {
    const state = roomStates[roomId];
    if (!state) return null;
    let liveTime = state.currentTime || 0;
    if (state.isPlaying && state.lastUpdated) {
      const elapsed = (Date.now() - state.lastUpdated) / 1000;
      liveTime += elapsed;
    }
    return {
      ...state,
      currentTime: liveTime
    };
  }

  socket.on("join-room", ({ roomId, user }) => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = sanitizeRoomId(roomId);
    socket.join(currentRoom);

    if (!roomStates[currentRoom]) {
      roomStates[currentRoom] = {
        source: "",
        isPlaying: false,
        currentTime: 0,
        lastUpdated: Date.now(),
        autoNext: false,
        currentFolder: null
      };
    }

    socket.emit("sync-state", getLiveRoomState(currentRoom));
    io.to(currentRoom).emit("user-joined", {
      user,
      count: io.sockets.adapter.rooms.get(currentRoom)?.size || 1
    });
  });

  socket.on("request-sync", () => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    socket.emit("sync-state", getLiveRoomState(currentRoom));
  });

  socket.on("video-progress", ({ time }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].currentTime = time;
    roomStates[currentRoom].lastUpdated = Date.now();
  });

  socket.on("video-play", ({ time }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].isPlaying = true;
    roomStates[currentRoom].currentTime = time;
    roomStates[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit("video-play", { time });
  });

  socket.on("video-pause", ({ time }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].isPlaying = false;
    roomStates[currentRoom].currentTime = time;
    roomStates[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit("video-pause", { time });
  });

  socket.on("video-seek", ({ time }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].currentTime = time;
    roomStates[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit("video-seek", { time });
  });

  socket.on("change-source", ({ source, folder }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].source = source;
    roomStates[currentRoom].currentTime = 0;
    roomStates[currentRoom].isPlaying = true;
    roomStates[currentRoom].lastUpdated = Date.now();
    if (folder !== undefined) {
      roomStates[currentRoom].currentFolder = folder;
    }
    io.to(currentRoom).emit("change-source", {
      source,
      folder: roomStates[currentRoom].currentFolder
    });
  });

  socket.on("set-auto-next", ({ enabled, folder }) => {
    if (!currentRoom || !roomStates[currentRoom]) return;
    roomStates[currentRoom].autoNext = !!enabled;
    if (folder !== undefined) {
      roomStates[currentRoom].currentFolder = folder;
    }
    io.to(currentRoom).emit("auto-next-changed", {
      autoNext: roomStates[currentRoom].autoNext,
      currentFolder: roomStates[currentRoom].currentFolder
    });
  });

  // Handle Video Ended (playback finished - no auto-deletion)
  socket.on("video-ended", () => {
    if (currentRoom && roomStates[currentRoom]) {
      roomStates[currentRoom].isPlaying = false;
      roomStates[currentRoom].lastUpdated = Date.now();
    }
  });

  socket.on("disconnect", () => {
    activePlaybackSessions.set(socket.id, Date.now());
    setTimeout(() => {
      if (!io.sockets.sockets.has(socket.id)) {
        activePlaybackSessions.delete(socket.id);
      }
    }, 180000);

    if (currentRoom) {
      io.to(currentRoom).emit("user-left", {
        count: io.sockets.adapter.rooms.get(currentRoom)?.size || 0
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`> TachyonStream server running at http://localhost:${server.address().port}`);
}).on("error", (err) => {
  console.error("Server listen error:", err);
});
