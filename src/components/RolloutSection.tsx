import { useState, useEffect, useRef } from "react";
import {
  fetchDatasetInfo,
  getVideoUrl,
  type EpisodeMetadata,
} from "../lib/hf-api";
import type { Id } from "../../convex/_generated/dataModel";

export interface RolloutResult {
  session_id: Id<"evalSessions">;
  dataset_repo: string;
  round_index: number;
  episode_index: number;
  success: boolean;
  num_frames: number | null;
  session_creation_time: number;
}

interface DatasetCache {
  episodeMap: Map<number, EpisodeMetadata>;
  cameraKey: string;
}

function RolloutVideoCard({
  result,
  datasetCache,
  onClick,
  isExpanded,
}: {
  result: RolloutResult;
  datasetCache: DatasetCache | null;
  onClick: () => void;
  isExpanded: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);

  const episode = datasetCache?.episodeMap.get(result.episode_index);

  useEffect(() => {
    if (!playing || !videoRef.current || !episode) return;

    const video = videoRef.current;
    video.play();

    const sync = () => {
      if (video.currentTime >= episode.toTimestamp - 0.05) {
        video.pause();
        video.currentTime = episode.fromTimestamp;
        setPlaying(false);
        return;
      }
      animFrameRef.current = requestAnimationFrame(sync);
    };
    animFrameRef.current = requestAnimationFrame(sync);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      video.pause();
    };
  }, [playing, episode]);

  if (!datasetCache || !episode) {
    return (
      <div
        className="rounded-lg bg-warm-100 aspect-video flex items-center justify-center text-ink-muted text-xs cursor-pointer hover:bg-warm-200 transition-colors"
        onClick={onClick}
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg overflow-hidden border transition-all ${
        isExpanded
          ? "border-teal shadow-md col-span-2 row-span-2"
          : "border-warm-200 hover:border-warm-300 hover:shadow-sm cursor-pointer"
      }`}
    >
      <div className="relative" onClick={isExpanded ? undefined : onClick}>
        <video
          ref={videoRef}
          src={getVideoUrl(
            datasetCache.cameraKey,
            episode.videoFileIndex,
            result.dataset_repo
          )}
          className="w-full bg-warm-100"
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            (e.target as HTMLVideoElement).currentTime = episode.fromTimestamp;
          }}
        />
        {/* Overlay badges */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          {result.success ? (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/80 text-white text-[10px] font-medium">
              OK
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-red-500/80 text-white text-[10px] font-medium">
              FAIL
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-black/50 text-white/80 text-[10px] font-mono">
            R{result.round_index}
          </span>
          {result.num_frames != null && (
            <span className="px-1.5 py-0.5 rounded bg-black/40 text-white/80 text-[10px] font-mono">
              {result.num_frames} steps
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2">
          <span className="px-1.5 py-0.5 rounded bg-black/40 text-white/70 text-[9px] font-mono">
            Ep {result.episode_index}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 py-2 bg-warm-50 border-t border-warm-200">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-ink-muted">
              <span className="font-mono">
                {new Date(result.session_creation_time).toLocaleDateString()}
              </span>
              <span className="mx-1.5">&middot;</span>
              <a
                href={`https://huggingface.co/datasets/${result.dataset_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal hover:underline font-mono"
              >
                {result.dataset_repo}
              </a>
            </div>
            <button
              onClick={onClick}
              className="text-xs text-ink-muted hover:text-ink transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setPlaying((p) => !p)}
              className="flex items-center gap-2 px-3 py-1 rounded-lg bg-teal text-white font-body font-medium text-xs hover:bg-teal/90 transition-colors cursor-pointer"
            >
              {playing ? (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <polygon points="6,4 20,12 6,20" />
                </svg>
              )}
              {playing ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                if (videoRef.current) {
                  videoRef.current.currentTime = episode.fromTimestamp;
                }
              }}
              className="flex items-center gap-2 px-2.5 py-1 rounded-lg border border-warm-200 text-ink-muted font-body text-xs hover:bg-warm-50 transition-colors cursor-pointer"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RolloutSection({
  results,
  isOpen,
}: {
  results: RolloutResult[];
  isOpen: boolean;
}) {
  const [datasetCaches, setDatasetCaches] = useState<
    Map<string, DatasetCache>
  >(new Map());
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch dataset info for all unique datasets — only when section is open
  useEffect(() => {
    if (!isOpen || results.length === 0) return;

    const uniqueRepos = [...new Set(results.map((f) => f.dataset_repo))];
    const missing = uniqueRepos.filter((repo) => !datasetCaches.has(repo));
    if (missing.length === 0) return;

    setLoading(true);
    Promise.all(
      missing.map(async (repo) => {
        const info = await fetchDatasetInfo(repo);
        const episodeMap = new Map<number, EpisodeMetadata>();
        for (const ep of info.episodes) {
          episodeMap.set(ep.episodeIndex, ep);
        }
        const cameraKey =
          info.cameraKeys.length > 1
            ? info.cameraKeys[info.cameraKeys.length - 1]
            : info.cameraKeys[0];
        return [repo, { episodeMap, cameraKey }] as const;
      })
    )
      .then((fetched) => {
        setDatasetCaches((prev) => {
          const next = new Map(prev);
          for (const [repo, cache] of fetched) {
            next.set(repo, cache);
          }
          return next;
        });
      })
      .catch(() => {
        // Dataset fetch failed — cards will show "Loading..."
      })
      .finally(() => setLoading(false));
  }, [isOpen, results]);

  if (!isOpen) return null;

  if (results.length === 0) {
    return (
      <div className="text-xs text-ink-muted py-2">
        No episodes recorded.
      </div>
    );
  }

  // Group by dataset for display
  const grouped = new Map<string, RolloutResult[]>();
  for (const r of results) {
    const key = r.dataset_repo;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  return (
    <div className="pt-3">
      {loading && (
        <div className="flex items-center gap-2 mb-3 text-xs text-ink-muted">
          <div className="w-3 h-3 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          Loading video data...
        </div>
      )}

      {Array.from(grouped.entries()).map(([repo, repoResults]) => (
        <div key={repo} className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <a
              href={`https://huggingface.co/datasets/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-teal hover:underline font-mono"
            >
              {repo}
            </a>
            <span className="text-[11px] text-ink-muted">
              ({repoResults.length} episode
              {repoResults.length !== 1 ? "s" : ""})
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {repoResults.map((result) => {
              const globalIdx = results.indexOf(result);
              return (
                <RolloutVideoCard
                  key={`${result.session_id}-${result.episode_index}`}
                  result={result}
                  datasetCache={datasetCaches.get(repo) ?? null}
                  onClick={() =>
                    setExpandedIdx(
                      expandedIdx === globalIdx ? null : globalIdx
                    )
                  }
                  isExpanded={expandedIdx === globalIdx}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
