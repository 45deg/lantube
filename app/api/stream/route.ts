import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveSafePath } from "@/lib/path-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    return new Response("Missing path", { status: 400 });
  }

  let absPath: string;
  try {
    absPath = resolveSafePath(relPath);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }

  const stat = await fs.promises.stat(absPath);
  const fileSize = stat.size;
  const range = request.headers.get("range");
  const contentType = MIME[path.extname(absPath).toLowerCase()] ?? "video/mp4";

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = Number.parseInt(startStr, 10);
    const end = endStr ? Number.parseInt(endStr, 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize || end < start) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(absPath, { start, end });
    return createStreamResponse(request, stream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type": contentType,
      },
    });
  }

  const stream = fs.createReadStream(absPath);
  return createStreamResponse(request, stream, {
    headers: {
      "Content-Length": fileSize.toString(),
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    },
  });
}

function createStreamResponse(
  request: NextRequest,
  stream: fs.ReadStream,
  init: ResponseInit
) {
  const onAbort = () => {
    stream.destroy();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  stream.on("error", () => {
    // swallow stream errors caused by client aborts
  });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, init);
}
