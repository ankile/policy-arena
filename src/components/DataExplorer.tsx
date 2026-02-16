import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParam, useSearchParamNullable, useSearchParamNumber, clearSearchParams } from "../lib/useSearchParam";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  fetchDatasetInfo,
  getVideoUrl,
  type EpisodeMetadata,
} from "../lib/hf-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceTypeFilter = "all" | "teleop" | "rollout" | "dagger" | "eval";

const SOURCE_TYPE_FILTERS: { id: SourceTypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "teleop", label: "Teleop" },
  { id: "rollout", label: "Rollout" },
  { id: "dagger", label: "DAgger" },
  { id: "eval", label: "Eval" },
];


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Camera serial number → role mapping (DROID ZED cameras)
// 18650758: wrist-mounted camera
// 25916956: side-mounted camera
const CAMERA_ROLES: Record<string, string> = {
  "18650758": "Wrist View",
  "25916956": "Side View",
};

function cameraDisplayName(key: string): string {
  for (const [serial, name] of Object.entries(CAMERA_ROLES)) {
    if (key.includes(serial)) return name;
  }
  return key; // fallback to raw key
}

function isWristCamera(key: string): boolean {
  return key.includes("18650758");
}

function sortCameraKeys(keys: string[]): string[] {
  // Side view first, wrist view second
  return [...keys].sort((a, b) => {
    const aIsWrist = isWristCamera(a) ? 1 : 0;
    const bIsWrist = isWristCamera(b) ? 1 : 0;
    return aIsWrist - bIsWrist;
  });
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds * 10) / 10;
  return `${s.toFixed(1)}s`;
}

function SourceTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    teleop: "bg-blue-100 text-blue-700",
    rollout: "bg-purple-100 text-purple-700",
    dagger: "bg-amber-100 text-amber-700",
    eval: "bg-teal-light text-teal",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${
        colors[type] ?? "bg-warm-100 text-ink-muted"
      }`}
    >
      {type === "dagger" ? "DAgger" : type}
    </span>
  );
}

function EnvironmentTag({ env }: { env: string }) {
  const colors: Record<string, string> = {
    franka_pick_cube: "bg-teal-light text-teal",
    franka_nut_assembly_square: "bg-coral-light text-coral",
    franka_stack_two_blocks: "bg-gold-light text-gold",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
        colors[env] ?? "bg-warm-100 text-ink-muted"
      }`}
    >
      {env}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Video Grid (synced multi-camera playback)
// ---------------------------------------------------------------------------

function VideoGrid({
  episode,
  playing,
  onTogglePlay,
  cameraKeys,
  datasetId,
}: {
  episode: EpisodeMetadata;
  playing: boolean;
  onTogglePlay: () => void;
  cameraKeys: string[];
  datasetId: string;
}) {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const primaryRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number>(0);

  const setVideoRef = useCallback(
    (index: number) => (el: HTMLVideoElement | null) => {
      videoRefs.current[index] = el;
      if (index === 0) primaryRef.current = el;
    },
    []
  );

  useEffect(() => {
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];
    for (const video of videos) {
      video.pause();
      video.currentTime = episode.fromTimestamp;
    }
  }, [episode]);

  useEffect(() => {
    const primary = primaryRef.current;
    if (!primary) return;
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];

    if (playing) {
      for (const v of videos) v.play();
      const sync = () => {
        const t = primary.currentTime;
        for (let i = 1; i < videos.length; i++) {
          if (Math.abs(videos[i].currentTime - t) > 0.1) {
            videos[i].currentTime = t;
          }
        }
        if (t >= episode.toTimestamp - 0.05) {
          for (const v of videos) {
            v.pause();
            v.currentTime = episode.fromTimestamp;
          }
          onTogglePlay();
          return;
        }
        animFrameRef.current = requestAnimationFrame(sync);
      };
      animFrameRef.current = requestAnimationFrame(sync);
    } else {
      for (const v of videos) v.pause();
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [playing, episode, onTogglePlay]);

  const gridCols = cameraKeys.length === 1 ? "grid-cols-1" : "grid-cols-2";

  return (
    <div>
      <div className={`grid ${gridCols} gap-3`}>
        {cameraKeys.map((key, i) => (
          <div key={key} className="relative">
            <video
              ref={setVideoRef(i)}
              src={getVideoUrl(key, episode.videoFileIndex, datasetId)}
              className="w-full rounded-lg bg-warm-100"
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                (e.target as HTMLVideoElement).currentTime =
                  episode.fromTimestamp;
              }}
            />
            <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px] font-mono">
              {cameraDisplayName(key)}
            </span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 mt-4">
        <button
          onClick={onTogglePlay}
          className="flex items-center gap-2 px-5 py-2 rounded-lg bg-teal text-white font-body font-medium text-sm hover:bg-teal/90 transition-colors cursor-pointer"
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
          {playing ? "Pause" : "Play"}
        </button>

        <button
          onClick={() => {
            const videos = videoRefs.current.filter(
              Boolean
            ) as HTMLVideoElement[];
            for (const v of videos) {
              v.currentTime = episode.fromTimestamp;
            }
            if (playing) onTogglePlay();
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-warm-200 text-ink-muted font-body text-sm hover:bg-warm-50 transition-colors cursor-pointer"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Reset
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Episode Card
// ---------------------------------------------------------------------------

function EpisodeCard({
  episode,
  selected,
  onClick,
}: {
  episode: EpisodeMetadata;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 px-4 py-3 rounded-xl border transition-all duration-150 text-left cursor-pointer ${
        selected
          ? "bg-teal/10 border-teal shadow-sm"
          : "bg-white border-warm-200 hover:border-warm-300 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-sm font-medium text-ink">
          Ep {episode.episodeIndex}
        </span>
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${
            episode.success
              ? "bg-teal-light text-teal"
              : "bg-coral-light text-coral"
          }`}
        >
          {episode.success ? "Success" : "Fail"}
        </span>
      </div>
      <div className="text-xs text-ink-muted font-mono">
        {formatDuration(episode.duration)} &middot; {episode.numFrames}f
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dataset Detail Panel
// ---------------------------------------------------------------------------

function DatasetDetail({
  repoId,
  onBack,
}: {
  repoId: string;
  onBack: () => void;
}) {
  const [episodes, setEpisodes] = useState<EpisodeMetadata[]>([]);
  const [cameraKeys, setCameraKeys] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useSearchParamNumber("episode");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodeFilter, setEpisodeFilter] = useSearchParam("outcome", "all");

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelectedIndex(null);
    setPlaying(false);
    setEpisodeFilter("all");

    fetchDatasetInfo(repoId)
      .then((info) => {
        setEpisodes(info.episodes);
        const leftCams = info.cameraKeys.filter((k) => k.includes("left"));
        const cams = leftCams.length > 0 ? leftCams : info.cameraKeys;
        setCameraKeys(sortCameraKeys(cams));
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [repoId]);

  const handleTogglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  const filteredEpisodes =
    episodeFilter === "all"
      ? episodes
      : episodeFilter === "success"
        ? episodes.filter((e) => e.success)
        : episodes.filter((e) => !e.success);

  const selectedEpisode =
    selectedIndex !== null ? episodes[selectedIndex] : null;

  const successCount = episodes.filter((e) => e.success).length;

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <div className="flex items-center justify-center gap-3 text-ink-muted">
          <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          <span className="font-body">Loading episodes from HuggingFace...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <button
          onClick={onBack}
          className="text-xs text-ink-muted hover:text-teal mb-4 cursor-pointer"
        >
          &larr; Back to datasets
        </button>
        <p className="text-coral font-body text-center">
          Failed to load episodes: {error}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-warm-100 bg-warm-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="text-ink-muted hover:text-teal transition-colors cursor-pointer"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div>
              <h2 className="font-display text-xl text-ink">
                {repoId.split("/").pop()}
              </h2>
              <p className="text-xs text-ink-muted mt-0.5 font-mono">
                {repoId}
              </p>
            </div>
          </div>
          <a
            href={`https://huggingface.co/datasets/${repoId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-muted hover:text-teal transition-colors font-mono"
          >
            HuggingFace &rarr;
          </a>
        </div>
      </div>

      <div className="p-6">
        {/* Summary stats */}
        <div className="flex gap-4 mb-6">
          {[
            { label: "Episodes", value: episodes.length.toString() },
            {
              label: "Success Rate",
              value:
                episodes.length > 0
                  ? `${Math.round((successCount / episodes.length) * 100)}%`
                  : "-",
            },
            { label: "Cameras", value: cameraKeys.length.toString() },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-warm-50 rounded-lg px-4 py-2.5 border border-warm-100"
            >
              <div className="text-[10px] uppercase tracking-widest text-ink-muted font-medium mb-0.5">
                {stat.label}
              </div>
              <div className="font-mono text-lg font-medium text-ink">
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* Episode filter pills */}
        <div className="flex items-center gap-2 mb-4">
          {(
            [
              { id: "all" as const, label: "All", count: episodes.length },
              {
                id: "success" as const,
                label: "Success",
                count: successCount,
              },
              {
                id: "failure" as const,
                label: "Failure",
                count: episodes.length - successCount,
              },
            ] as const
          ).map((filter) => {
            const isActive = episodeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => setEpisodeFilter(filter.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  isActive
                    ? "bg-teal text-white shadow-sm"
                    : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300 hover:text-ink"
                }`}
              >
                {filter.label}
                <span
                  className={`font-mono text-[10px] ${
                    isActive ? "text-white/70" : "text-ink-muted/60"
                  }`}
                >
                  {filter.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Episode strip */}
        <div className="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1">
          {filteredEpisodes.map((ep) => {
            const globalIndex = episodes.indexOf(ep);
            return (
              <EpisodeCard
                key={ep.episodeIndex}
                episode={ep}
                selected={selectedIndex === globalIndex}
                onClick={() => {
                  setPlaying(false);
                  setSelectedIndex(globalIndex);
                }}
              />
            );
          })}
        </div>

        {/* Video grid */}
        {selectedEpisode ? (
          <div className="mt-5">
            <div className="flex items-center gap-3 mb-4">
              <span className="font-display text-lg text-ink">
                Episode {selectedEpisode.episodeIndex}
              </span>
              <span
                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                  selectedEpisode.success
                    ? "bg-teal-light text-teal"
                    : "bg-coral-light text-coral"
                }`}
              >
                {selectedEpisode.success ? "Success" : "Failure"}
              </span>
              <span className="text-xs text-ink-muted font-mono">
                {selectedEpisode.numFrames} frames &middot;{" "}
                {formatDuration(selectedEpisode.duration)} &middot; 15 FPS
              </span>
            </div>
            <VideoGrid
              episode={selectedEpisode}
              playing={playing}
              onTogglePlay={handleTogglePlay}
              cameraKeys={cameraKeys}
              datasetId={repoId}
            />
          </div>
        ) : (
          <div className="mt-5 py-12 text-center text-ink-muted font-body">
            Select an episode above to view camera recordings
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main DataExplorer component
// ---------------------------------------------------------------------------

export default function DataExplorer() {
  const [sourceFilter, setSourceFilter] = useSearchParam("source", "all");
  const [taskFilter, setTaskFilter] = useSearchParam("task", "all");
  const [selectedRepoId, setSelectedRepoIdRaw] = useSearchParamNullable("dataset");

  const setSelectedRepoId = (id: string | null) => {
    if (id === null) clearSearchParams("episode", "outcome");
    setSelectedRepoIdRaw(id);
  };

  const datasets = useQuery(
    api.datasets.list,
    sourceFilter === "all" ? {} : { source_type: sourceFilter }
  );

  if (datasets === undefined) {
    return (
      <div
        className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8"
        style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
      >
        <div className="flex items-center justify-center gap-3 text-ink-muted">
          <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          <span className="font-body">Loading datasets...</span>
        </div>
      </div>
    );
  }

  if (datasets.length === 0 && sourceFilter === "all") {
    return (
      <div
        className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted"
        style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
      >
        No datasets registered yet. Use <code className="font-mono text-xs bg-warm-100 px-1.5 py-0.5 rounded">--arena-url</code> when pushing datasets to register them.
      </div>
    );
  }

  // If a dataset is selected, show its detail view
  if (selectedRepoId) {
    return (
      <div style={{ animation: "fade-up 0.6s ease-out 0.1s both" }}>
        <DatasetDetail
          repoId={selectedRepoId}
          onBack={() => setSelectedRepoId(null)}
        />
      </div>
    );
  }

  // Compute unique tasks for filter pills
  const allTasks = [...new Set(datasets.map((d) => d.task))].sort();

  // Compute source type counts (from all datasets before task filter)
  const sourceTypeCounts = new Map<string, number>();
  for (const d of datasets) {
    sourceTypeCounts.set(d.source_type, (sourceTypeCounts.get(d.source_type) ?? 0) + 1);
  }

  // Apply task filter
  const filteredDatasets =
    taskFilter === "all"
      ? datasets
      : datasets.filter((d) => d.task === taskFilter);

  return (
    <div
      className="space-y-4"
      style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
    >
      {/* Filter bars */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Source type filters */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium mr-1">
            Source
          </span>
          {SOURCE_TYPE_FILTERS.map((filter) => {
            const count =
              filter.id === "all"
                ? datasets.length
                : sourceTypeCounts.get(filter.id) ?? 0;
            const isActive = sourceFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => setSourceFilter(filter.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  isActive
                    ? "bg-teal text-white shadow-sm"
                    : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300 hover:text-ink"
                }`}
              >
                {filter.label}
                <span
                  className={`font-mono text-[10px] ${
                    isActive ? "text-white/70" : "text-ink-muted/60"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Task filter */}
        {allTasks.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium mr-1">
              Task
            </span>
            <button
              onClick={() => setTaskFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                taskFilter === "all"
                  ? "bg-teal text-white shadow-sm"
                  : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300 hover:text-ink"
              }`}
            >
              All
            </button>
            {allTasks.map((task) => {
              const isActive = taskFilter === task;
              return (
                <button
                  key={task}
                  onClick={() => setTaskFilter(task)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    isActive
                      ? "bg-teal text-white shadow-sm"
                      : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300 hover:text-ink"
                  }`}
                >
                  {task}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Dataset list */}
      {filteredDatasets.length === 0 ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
          No datasets match the current filters.
        </div>
      ) : (
        <div className="grid gap-3">
          {filteredDatasets.map((dataset) => (
            <button
              key={dataset._id}
              onClick={() => setSelectedRepoId(dataset.repo_id)}
              className="bg-white rounded-xl border border-warm-200 shadow-sm px-5 py-4 text-left hover:border-warm-300 hover:shadow-md transition-all cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-body font-semibold text-ink text-[15px]">
                      {dataset.name}
                    </span>
                    <SourceTypeBadge type={dataset.source_type} />
                    <EnvironmentTag env={dataset.environment} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-ink-muted">
                    {dataset.num_episodes != null && Number(dataset.num_episodes) > 0 && (
                      <span className="font-mono">
                        {Number(dataset.num_episodes)} episodes
                      </span>
                    )}
                    {dataset.wandb_artifact && (
                      <span className="font-mono truncate max-w-[300px]">
                        {dataset.wandb_artifact}
                      </span>
                    )}
                    <span>
                      {new Date(dataset._creationTime).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric", year: "numeric" }
                      )}
                    </span>
                  </div>
                </div>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-ink-muted/40"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
