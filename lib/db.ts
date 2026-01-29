import "server-only";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./config";

let db: DatabaseSync | null = null;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(dbPath);
  }
  return db;
}

export function initDb() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      path TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      name TEXT NOT NULL,
      duration REAL,
      createdAt INTEGER,
      thumb TEXT,
      updatedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder);
  `);
}
