import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDuration, getFolders, getVideosInFolder, folderExists } from "@/lib/video-index";
import { decodePathSegments, joinRelPath, toUrlPath } from "@/lib/path-utils";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ sort?: string; order?: string; cols?: string }>;
};

const SORT_LABELS: Record<string, string> = {
  createdAt: "作成時",
  name: "名前",
  duration: "時間",
};

export default async function FolderPage({ params, searchParams }: PageProps) {
  const [sp, p] = await Promise.all([searchParams, params]);
  const segments = decodePathSegments(p.path);
  const relFolder = joinRelPath(segments);
  const exists = await folderExists(relFolder);
  if (!exists) {
    notFound();
  }

  const sort = (sp.sort ?? "createdAt") as "createdAt" | "name" | "duration";
  const order = (sp.order ?? "desc") as "asc" | "desc";
  const cols = Math.max(1, Math.min(5, Number(sp.cols ?? 3)));

  const [folders, videos] = await Promise.all([
    getFolders(relFolder),
    getVideosInFolder(relFolder, sort, order),
  ]);

  const breadcrumb = segments.map((segment, index) => {
    const path = segments.slice(0, index + 1);
    return {
      name: segment,
      path: toUrlPath(path),
    };
  });

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
          <h1 className="text-2xl font-semibold">{segments.at(-1)}</h1>
          <nav className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
            <Link href="/" className="font-medium text-zinc-800">
              トップ
            </Link>
            {breadcrumb.map((item) => (
              <span key={item.path} className="flex items-center gap-2">
                <span>/</span>
                <Link href={`/folder/${item.path}`} className="font-medium text-zinc-800">
                  {item.name}
                </Link>
              </span>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
        <section>
          <h2 className="text-lg font-semibold">フォルダ</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {folders.length === 0 ? (
              <p className="text-sm text-zinc-500">サブフォルダはありません。</p>
            ) : (
              folders.map((folder) => (
                <Link
                  key={folder.path}
                  href={`/folder/${toUrlPath(folder.path.split("/"))}`}
                  className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition hover:border-zinc-300"
                >
                  <span className="text-xl">📁</span>
                  <span className="truncate font-medium">{folder.name}</span>
                </Link>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">動画リスト</h2>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">並び替え:</span>
                {Object.entries(SORT_LABELS).map(([key, label]) => (
                  <Link
                    key={key}
                    href={buildQuery(`/folder/${toUrlPath(segments)}`, {
                      sort: key,
                      order: key === sort ? (order === "asc" ? "desc" : "asc") : order,
                      cols: cols.toString(),
                    })}
                    className={
                      key === sort
                        ? "rounded-full bg-zinc-900 px-3 py-1 text-white"
                        : "rounded-full border border-zinc-300 px-3 py-1"
                    }
                  >
                    {label}
                  </Link>
                ))}
                <Link
                  href={buildQuery(`/folder/${toUrlPath(segments)}`, {
                    sort,
                    order: order === "asc" ? "desc" : "asc",
                    cols: cols.toString(),
                  })}
                  className="rounded-full border border-zinc-300 px-3 py-1"
                >
                  {order === "asc" ? "↑" : "↓"}
                </Link>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">列数:</span>
                {[1, 2, 3, 5].map((value) => (
                  <Link
                    key={value}
                    href={buildQuery(`/folder/${toUrlPath(segments)}`, {
                      sort,
                      order,
                      cols: value.toString(),
                    })}
                    className={
                      value === cols
                        ? "rounded-full bg-zinc-900 px-3 py-1 text-white"
                        : "rounded-full border border-zinc-300 px-3 py-1"
                    }
                  >
                    {value}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div
            className={
              cols === 1 ? "mt-6 flex flex-col gap-3" : "mt-6 grid gap-4"
            }
            style={
              cols === 1
                ? undefined
                : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
            }
          >
            {videos.length === 0 ? (
              <p className="text-sm text-zinc-500">動画がありません。</p>
            ) : (
              videos.map((video) => (
                <Link
                  key={video.path}
                  href={`/watch/${toUrlPath(video.path.split("/"))}`}
                  className={
                    cols === 1
                      ? "group flex items-center gap-4 overflow-hidden rounded-lg border border-zinc-200 bg-white p-3 transition hover:border-zinc-300"
                      : "group flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white transition hover:border-zinc-300"
                  }
                >
                  <div
                    className={
                      cols === 1
                        ? "thumb-frame w-40 shrink-0 overflow-hidden rounded-md bg-zinc-100"
                        : "thumb-frame w-full bg-zinc-100"
                    }
                  >
                    {!video.thumbError && (
                      <img
                        src={`/api/thumb?path=${encodeURIComponent(video.path)}`}
                        alt={video.name}
                        className="thumb-image h-full w-full object-cover"
                        loading="lazy"
                      />
                    )}
                  </div>
                  <div
                    className={
                      cols === 1 ? "flex flex-1 flex-col gap-2" : "flex flex-1 flex-col gap-2 p-3"
                    }
                  >
                    <p className="line-clamp-2 text-sm font-medium text-zinc-900">
                      {video.name}
                    </p>
                    <span className="text-xs text-zinc-500">
                      {formatDuration(video.duration)}
                    </span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function buildQuery(base: string, params: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      sp.set(key, value);
    }
  });
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}
