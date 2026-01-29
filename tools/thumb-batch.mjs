import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const MAX_CONCURRENCY = Math.max(2, Math.min(os.cpus().length, 6));

const env = await loadEnv();
const rebuild = process.argv.includes("--rebuild");
const smartThumb = env.SMART_THUMB === "1";
const targetDir = env.TARGET_DIRECTORY ? path.resolve(env.TARGET_DIRECTORY) : null;

if (!targetDir) {
  console.error("TARGET_DIRECTORY is not set in .env.local");
  process.exit(1);
}

const thumbsDir = path.join(targetDir, ".thumbs.db");
const thumbsImageDir = path.join(thumbsDir, "thumbs");
const dbPath = path.join(thumbsDir, "index.sqlite");

await fs.mkdir(thumbsImageDir, { recursive: true });
await fs.mkdir(thumbsDir, { recursive: true });

const db = new DatabaseSync(dbPath);
initDb(db);

const files = await findVideos(targetDir);
const existingRows = db
  .prepare("SELECT path, updatedAt, thumb, duration, thumbError FROM videos")
  .all();
const existingMap = new Map(existingRows.map((row) => [row.path, row]));
const seen = new Set();
const tasks = [];

for (const file of files) {
  const { abs, rel, stat } = file;
  seen.add(rel);
  const existing = existingMap.get(rel);
  const updatedAt = Math.floor(stat.mtimeMs);
  const thumbRel = getThumbRelPath(rel);
  const thumbAbs = path.join(thumbsDir, thumbRel);
  const thumbExists = await fileExists(thumbAbs);
  const hasThumbError = existing?.thumbError === 1;
  const needsUpdate =
    rebuild ||
    !existing ||
    (!hasThumbError && (!thumbExists || !existing.duration)) ||
    (existing.updatedAt ?? 0) < updatedAt;

  if (needsUpdate) {
    tasks.push(() => indexSingle(db, { abs, rel, stat, updatedAt, thumbRel }));
  }
}

for (const row of existingRows) {
  if (!seen.has(row.path)) {
    db.prepare("DELETE FROM videos WHERE path = ?").run(row.path);
  }
}

await runWithConcurrency(tasks, MAX_CONCURRENCY);

console.log(`Done. Indexed ${files.length} videos.`);

function updateProgress(completed, total) {
  const percent = Math.floor((completed / total) * 100);
  const barLength = 20;
  const filled = Math.floor((completed / total) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
  process.stdout.write(`\r[${bar}] ${percent}% (${completed}/${total})`);
  if (completed === total) {
    process.stdout.write('\n');
  }
}

function initDb(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      path TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      name TEXT NOT NULL,
      duration REAL,
      createdAt INTEGER,
      thumb TEXT,
      updatedAt INTEGER,
      thumbError INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder);
  `);

  const columns = database.prepare("PRAGMA table_info(videos)").all();
  const hasThumbError = columns.some((column) => column.name === "thumbError");
  if (!hasThumbError) {
    database.exec("ALTER TABLE videos ADD COLUMN thumbError INTEGER DEFAULT 0");
  }
}

async function indexSingle(dbInstance, { abs, rel, stat, updatedAt, thumbRel }) {
  try {
    const duration = await probeDuration(abs);
    const createdAt = Math.floor(stat.birthtimeMs || stat.ctimeMs || Date.now());
    const name = path.basename(abs, path.extname(abs));
    const folder = path.dirname(rel) === "." ? "" : path.dirname(rel);
    const thumbAbs = path.join(thumbsDir, thumbRel);

    await makeThumbnail(abs, thumbAbs, duration);

    dbInstance
      .prepare(
        `INSERT INTO videos (path, folder, name, duration, createdAt, thumb, updatedAt, thumbError)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           folder = excluded.folder,
           name = excluded.name,
           duration = excluded.duration,
           createdAt = excluded.createdAt,
           thumb = excluded.thumb,
           updatedAt = excluded.updatedAt,
           thumbError = excluded.thumbError`
      )
      .run(rel, folder, name, duration, createdAt, thumbRel, updatedAt, 0);
  } catch (error) {
    console.error("Indexing failed", { rel, error });
    const name = path.basename(rel, path.extname(rel));
    const folder = path.dirname(rel) === "." ? "" : path.dirname(rel);
    dbInstance
      .prepare(
        `INSERT INTO videos (path, folder, name, duration, createdAt, thumb, updatedAt, thumbError)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           updatedAt = excluded.updatedAt,
           thumbError = excluded.thumbError,
           thumb = excluded.thumb`
      )
      .run(rel, folder, name, null, null, null, updatedAt, 1);
  }
}

async function findVideos(root) {
  const results = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === ".thumbs.db") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      const stat = await fs.stat(fullPath);
      results.push({
        abs: fullPath,
        rel: path.relative(targetDir, fullPath),
        stat: {
          mtimeMs: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs,
          ctimeMs: stat.ctimeMs,
        },
      });
    }
  }

  await walk(root);
  return results;
}

function getThumbRelPath(relPath) {
  const hash = crypto.createHash("sha1").update(relPath).digest("hex");
  return path.join("thumbs", `${hash.slice(0, 16)}.jpg`);
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      filePath,
    ]);
    const value = parseFloat(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function makeThumbnail(inputPath, outputPath, duration) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const hasDuration = duration && Number.isFinite(duration) && duration > 0;
  if (!hasDuration || !smartThumb) {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      inputPath,
      "-vf",
      "scale=320:180:force_original_aspect_ratio=increase,crop=320:180",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ]);
    return;
  }

  const picks = Array.from({ length: 5 }, (_, i) => (i + 0.5) / 5);
  const candidates = await Promise.all(
    picks.map(async (ratio, index) => {
      const time = clampTime(duration * ratio, duration);
      const tmpPath = `${outputPath}.tmp-${index}.jpg`;
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        time.toFixed(3),
        "-i",
        inputPath,
        "-vf",
        "scale=320:180:force_original_aspect_ratio=increase,crop=320:180",
        "-frames:v",
        "1",
        "-q:v",
        "2",
        tmpPath,
      ]);
      const stat = await fs.stat(tmpPath);
      return { path: tmpPath, size: stat.size };
    })
  );

  const best = candidates.reduce((prev, current) =>
    current.size > prev.size ? current : prev
  );
  await fs.rename(best.path, outputPath);
  await Promise.all(
    candidates
      .filter((item) => item.path !== best.path)
      .map((item) => fs.unlink(item.path).catch(() => undefined))
  );
}

function clampTime(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 1;
  }
  const min = 1;
  const max = Math.max(1, duration - 0.2);
  return Math.min(Math.max(value, min), max);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runWithConcurrency(tasks, limit) {
  const queue = tasks.slice();
  let completed = 0;
  const total = tasks.length;
  updateProgress(completed, total);

  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) return;
      await task();
      completed++;
      updateProgress(completed, total);
    }
  });
  await Promise.all(workers);
}

async function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  try {
    const content = await fs.readFile(envPath, "utf8");
    const result = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return { ...process.env };
  }
}
