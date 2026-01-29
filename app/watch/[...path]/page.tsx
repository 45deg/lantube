import Link from "next/link";
import { getVideoByPath } from "@/lib/video-index";
import { decodePathSegments, joinRelPath, toUrlPath } from "@/lib/path-utils";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

export default async function WatchPage({ params }: PageProps) {
  const p = await params;
  const segments = decodePathSegments(p.path);
  const relPath = joinRelPath(segments);
  const video = await getVideoByPath(relPath);
  const title = video?.name ?? segments.at(-1) ?? "";
  const folderPath = segments.slice(0, -1);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-6 py-6">
          <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
            <Link href="/" className="font-medium text-zinc-800">
              トップ
            </Link>
            {folderPath.length > 0 && (
              <>
                <span>/</span>
                <Link
                  href={`/folder/${toUrlPath(folderPath)}`}
                  className="font-medium text-zinc-800"
                >
                  {folderPath.at(-1)}
                </Link>
              </>
            )}
          </div>
          <h1 className="text-2xl font-semibold">{title}</h1>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
        <video
          className="aspect-video w-full rounded-xl bg-black"
          controls
          preload="metadata"
          src={`/api/stream?path=${encodeURIComponent(relPath)}`}
        />
      </main>
    </div>
  );
}
