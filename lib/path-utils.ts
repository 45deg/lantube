import "server-only";
import path from "node:path";
import { targetDir } from "./config";

export function toUrlPath(segments: string[]) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function joinRelPath(segments: string[] | undefined) {
  return (segments ?? []).join("/");
}

export function decodePathSegments(segments: string[] | undefined) {
  return (segments ?? []).map((segment) => {
    if (!segment.includes("%")) {
      return segment;
    }
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function resolveSafePath(relPath: string) {
  const abs = path.resolve(targetDir, relPath);
  const rel = path.relative(targetDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid path");
  }
  return abs;
}
