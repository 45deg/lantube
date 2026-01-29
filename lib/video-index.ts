import "server-only";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, initDb } from "./db";
import { targetDir, thumbsDir, thumbsImageDir } from "./config";
import { resolveSafePath } from "./path-utils";

const execFileAsync = promisify(execFile);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const MAX_CONCURRENCY = Math.max(2, Math.min(os.cpus().length, 6));
const SMART_THUMB = process.env.SMART_THUMB === "1";

export type VideoItem = {
  path: string;
  name: string;
  duration: number | null;
  createdAt: number | null;
  thumbError?: number | null;
};

type VideoFile = {
  abs: string;
  rel: string;
  stat: {
    mtimeMs: number;
    birthtimeMs: number;
    ctimeMs: number;
  };
};

let indexingPromise: Promise<void> | null = null;

export function formatDuration(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds)) {
    return "--:--";
  }
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

export async function ensureIndex() {
  if (!indexingPromise) {
    indexingPromise = buildIndex();
  }
  return indexingPromise;
}

export async function getFolders(relFolder = "") {
  const absFolder = relFolder ? resolveSafePath(relFolder) : targetDir;
  const entries = await fs.readdir(absFolder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.name !== ".thumbs.db")
    .map((entry) => ({
      name: entry.name,
      path: relFolder ? `${relFolder}/${entry.name}` : entry.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function folderExists(relFolder = "") {
  const absFolder = relFolder ? resolveSafePath(relFolder) : targetDir;
  try {
    const stat = await fs.stat(absFolder);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function getVideosInFolder(
  relFolder: string,
  sort: "duration" | "name" | "createdAt",
  order: "asc" | "desc"
) {
  await ensureIndex();
  const db = getDb();
  const sortMap: Record<string, string> = {
    duration: "duration",
    name: "name",
    createdAt: "createdAt",
  };
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const sortColumn = sortMap[sort] ?? "createdAt";
  const rows = db
    .prepare(
      `SELECT path, name, duration, createdAt, thumbError FROM videos WHERE folder = ? ORDER BY ${sortColumn} ${orderSql}`
    )
    .all(relFolder) as VideoItem[];
  return rows;
}

export async function getVideoByPath(relPath: string) {
  await ensureIndex();
  const db = getDb();
  const row = db
    .prepare(
      "SELECT path, name, duration, createdAt, thumb, thumbError FROM videos WHERE path = ?"
    )
    .get(relPath) as (VideoItem & { thumb?: string | null }) | undefined;
  return row ?? null;
}

export async function getThumbPath(relPath: string) {
  await ensureIndex();
  const db = getDb();
  const row = db
    .prepare("SELECT thumb, thumbError FROM videos WHERE path = ?")
    .get(relPath) as { thumb?: string | null; thumbError?: number | null } | undefined;
  if (!row?.thumb || row.thumbError) {
    return null;
  }
  return path.join(thumbsDir, row.thumb);
}

async function buildIndex() {
  await fs.mkdir(thumbsImageDir, { recursive: true });
  await fs.mkdir(thumbsDir, { recursive: true });
  initDb();

  const files = await findVideos(targetDir);
  const db = getDb();
  const existingRows = db
    .prepare("SELECT path, updatedAt, thumb, duration, thumbError FROM videos")
    .all() as {
    path: string;
    updatedAt?: number | null;
    thumb?: string | null;
    duration?: number | null;
    thumbError?: number | null;
  }[];
  const existingMap = new Map(existingRows.map((row) => [row.path, row]));
  const seen = new Set<string>();
  const tasks: Array<() => Promise<void>> = [];

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
      !existing ||
      (!hasThumbError && (!thumbExists || !existing.duration)) ||
      (existing.updatedAt ?? 0) < updatedAt;

    if (needsUpdate) {
      tasks.push(() =>
        indexSingle({
          abs,
          rel,
          stat,
          updatedAt,
          thumbRel,
        })
      );
    }
  }

  for (const row of existingRows) {
    if (!seen.has(row.path)) {
      db.prepare("DELETE FROM videos WHERE path = ?").run(row.path);
    }
  }

  await runWithConcurrency(tasks, MAX_CONCURRENCY);
}

async function indexSingle({
  abs,
  rel,
  stat,
  updatedAt,
  thumbRel,
}: {
  abs: string;
  rel: string;
  stat: { birthtimeMs: number; ctimeMs: number };
  updatedAt: number;
  thumbRel: string;
}) {
  try {
    const duration = await probeDuration(abs);
    const createdAt = Math.floor(stat.birthtimeMs || stat.ctimeMs || Date.now());
    const name = path.basename(abs, path.extname(abs));
    const folder = path.dirname(rel) === "." ? "" : path.dirname(rel);
    const thumbAbs = path.join(thumbsDir, thumbRel);

    await makeThumbnail(abs, thumbAbs, duration);

    const db = getDb();
    db.prepare(
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
    ).run(rel, folder, name, duration, createdAt, thumbRel, updatedAt, 0);
  } catch (error) {
    console.error("Indexing failed", { rel, error });
    const db = getDb();
    const name = path.basename(rel, path.extname(rel));
    const folder = path.dirname(rel) === "." ? "" : path.dirname(rel);
    db.prepare(
      `INSERT INTO videos (path, folder, name, duration, createdAt, thumb, updatedAt, thumbError)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         updatedAt = excluded.updatedAt,
         thumbError = excluded.thumbError,
         thumb = excluded.thumb`
    ).run(rel, folder, name, null, null, null, updatedAt, 1);
  }
}

async function findVideos(root: string) {
  const results: VideoFile[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === ".thumbs.db") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) {
        continue;
      }
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

function getThumbRelPath(relPath: string) {
  const hash = crypto.createHash("sha1").update(relPath).digest("hex");
  return path.join("thumbs", `${hash.slice(0, 16)}.jpg`);
}

async function probeDuration(filePath: string) {
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

async function makeThumbnail(
  inputPath: string,
  outputPath: string,
  duration: number | null
) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const hasDuration = duration && Number.isFinite(duration) && duration > 0;
  if (!hasDuration || !SMART_THUMB) {
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
      const time = clampTime((duration as number) * ratio, duration as number);
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

function clampTime(value: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 1;
  }
  const min = 1;
  const max = Math.max(1, duration - 0.2);
  return Math.min(Math.max(value, min), max);
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number) {
  const queue = tasks.slice();
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) {
        return;
      }
      await task();
    }
  });
  await Promise.all(workers);
}
