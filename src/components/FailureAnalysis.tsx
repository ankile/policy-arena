import { useState, useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  fetchDatasetInfo,
  getVideoUrl,
  type EpisodeMetadata,
} from "../lib/hf-api";

interface FailureResult {
  session_id: Id<"evalSessions">;
  dataset_repo: string;
  round_index: number;
  episode_index: number;
  num_frames: number | null;
  session_creation_time: number;
}

interface DatasetCache {
  episodeMap: Map<number, EpisodeMetadata>;
  cameraKey: string;
}

function FailureVideoCard({
  failure,
  datasetCache,
  onClick,
  isExpanded,
}: {
  failure: FailureResult;
  datasetCache: DatasetCache | null;
  onClick: () => void;
  isExpanded: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);

  const episode = datasetCache?.episodeMap.get(failure.episode_index);

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
            failure.dataset_repo
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
          <span className="px-1.5 py-0.5 rounded bg-red-500/80 text-white text-[10px] font-medium">
            FAIL
          </span>
          <span className="px-1.5 py-0.5 rounded bg-black/50 text-white/80 text-[10px] font-mono">
            R{failure.round_index}
          </span>
          {failure.num_frames != null && (
            <span className="px-1.5 py-0.5 rounded bg-black/40 text-white/80 text-[10px] font-mono">
              {failure.num_frames} steps
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2">
          <span className="px-1.5 py-0.5 rounded bg-black/40 text-white/70 text-[9px] font-mono">
            Ep {failure.episode_index}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 py-2 bg-warm-50 border-t border-warm-200">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-ink-muted">
              <span className="font-mono">
                {new Date(failure.session_creation_time).toLocaleDateString()}
              </span>
              <span className="mx-1.5">&middot;</span>
              <a
                href={`https://huggingface.co/datasets/${failure.dataset_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal hover:underline font-mono"
              >
                {failure.dataset_repo}
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

export default function FailureAnalysis({
  policyId,
}: {
  policyId: Id<"policies">;
}) {
  const failures = useQuery(api.roundResults.getFailuresByPolicy, {
    policy_id: policyId,
  });
  const [datasetCaches, setDatasetCaches] = useState<
    Map<string, DatasetCache>
  >(new Map());
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch dataset info for all unique datasets
  useEffect(() => {
    if (!failures || failures.length === 0) return;

    const uniqueRepos = [...new Set(failures.map((f) => f.dataset_repo))];
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
      .then((results) => {
        setDatasetCaches((prev) => {
          const next = new Map(prev);
          for (const [repo, cache] of results) {
            next.set(repo, cache);
          }
          return next;
        });
      })
      .catch(() => {
        // Dataset fetch failed — cards will show "Loading..."
      })
      .finally(() => setLoading(false));
  }, [failures]);

  if (failures === undefined) {
    return (
      <div className="text-xs text-ink-muted flex items-center gap-2">
        <div className="w-3 h-3 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
        Loading failure data...
      </div>
    );
  }

  if (failures.length === 0) {
    return (
      <div className="text-xs text-ink-muted">
        No failure episodes recorded.
      </div>
    );
  }

  // Group by dataset for display
  const grouped = new Map<string, FailureResult[]>();
  for (const f of failures) {
    const key = f.dataset_repo;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }

  // Flat list for indexing
  const allFailures = failures;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-medium text-ink">Failure Analysis</h3>
        <span className="px-2 py-0.5 rounded-full bg-coral-light text-coral text-[11px] font-medium">
          {failures.length} failure{failures.length !== 1 ? "s" : ""}
        </span>
        {loading && (
          <div className="w-3 h-3 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
        )}
      </div>

      {Array.from(grouped.entries()).map(([repo, repoFailures]) => (
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
              ({repoFailures.length} failure
              {repoFailures.length !== 1 ? "s" : ""})
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {repoFailures.map((failure) => {
              const globalIdx = allFailures.indexOf(failure);
              return (
                <FailureVideoCard
                  key={`${failure.session_id}-${failure.episode_index}`}
                  failure={failure}
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
