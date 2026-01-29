import { NextRequest } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getThumbPath } from "@/lib/video-index";
import { resolveSafePath } from "@/lib/path-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    return new Response("Missing path", { status: 400 });
  }

  try {
    resolveSafePath(relPath);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }

  const thumbPath = await getThumbPath(relPath);
  if (!thumbPath) {
    return new Response("Not found", { status: 404 });
  }

  const stat = await fs.promises.stat(thumbPath);
  const stream = fs.createReadStream(thumbPath);

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": stat.size.toString(),
      "Cache-Control": "public, max-age=3600",
    },
  });
}
