import "server-only";
import path from "node:path";

const rawTarget = process.env.TARGET_DIRECTORY;

if (!rawTarget) {
  throw new Error("TARGET_DIRECTORY is not set in .env.local");
}

export const targetDir = path.resolve(rawTarget);
export const thumbsDir = path.join(targetDir, ".thumbs.db");
export const thumbsImageDir = path.join(thumbsDir, "thumbs");
export const dbPath = path.join(thumbsDir, "index.sqlite");
