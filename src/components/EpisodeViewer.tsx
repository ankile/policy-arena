import { useEffect, useRef, useState, useCallback } from "react";
import {
  fetchEpisodeSubset,
  fetchSuccessStatus,
  getVideoUrl,
  type EpisodeMetadata,
} from "../lib/hf-api";

function formatDuration(seconds: number): string {
  const s = Math.round(seconds * 10) / 10;
  return `${s.toFixed(1)}s`;
}

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
  datasetId?: string;
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

  // Load videos when episode changes
  useEffect(() => {
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];
    for (const video of videos) {
      video.pause();
      video.currentTime = episode.fromTimestamp;
    }
  }, [episode]);

  // Sync playback
  useEffect(() => {
    const primary = primaryRef.current;
    if (!primary) return;

    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];

    if (playing) {
      for (const v of videos) v.play();

      // Sync secondary videos to primary
      const sync = () => {
        const t = primary.currentTime;
        for (let i = 1; i < videos.length; i++) {
          if (Math.abs(videos[i].currentTime - t) > 0.1) {
            videos[i].currentTime = t;
          }
        }

        // Stop at episode end
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
              Camera {i + 1}
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
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

interface EpisodeViewerProps {
  datasetId?: string;
  episodeIndex?: number;
}

export default function EpisodeViewer({
  datasetId,
  episodeIndex,
}: EpisodeViewerProps = {}) {
  const [episodes, setEpisodes] = useState<EpisodeMetadata[]>([]);
  const [cameraKeys, setCameraKeys] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelectedIndex(null);
    setPlaying(false);

    const resolvedId = datasetId ?? "ankile/dp-franka-pick-cube-2026-02-12";
    Promise.all([
      fetchEpisodeSubset(resolvedId, new Set()),
      fetchSuccessStatus(resolvedId).catch(() => new Map<number, boolean>()),
    ])
      .then(([parquetInfo, successMap]) => {
        const episodes = parquetInfo.episodes.map((ep) => ({
          ...ep,
          success: successMap.get(ep.episodeIndex) ?? false,
        }));
        setEpisodes(episodes);
        setCameraKeys(parquetInfo.cameraKeys);
        // If an episodeIndex was provided, select it
        if (episodeIndex !== undefined) {
          const idx = episodes.findIndex(
            (e) => e.episodeIndex === episodeIndex
          );
          if (idx >= 0) setSelectedIndex(idx);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [datasetId, episodeIndex]);

  const selectedEpisode =
    selectedIndex !== null ? episodes[selectedIndex] : null;

  const handleTogglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  const displayDatasetId = datasetId ?? "ankile/dp-franka-pick-cube-2026-02-12";

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <div className="flex items-center justify-center gap-3 text-ink-muted">
          <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          <span className="font-body">Loading episode data...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
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
          <div>
            <h2 className="font-display text-xl text-ink">Episode Viewer</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {episodes.length} episodes &middot;{" "}
              {episodes.filter((e) => e.success).length} successful &middot;{" "}
              {cameraKeys.length} camera view{cameraKeys.length !== 1 ? "s" : ""}
            </p>
          </div>
          <a
            href={`https://huggingface.co/datasets/${displayDatasetId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-muted hover:text-teal transition-colors font-mono"
          >
            HuggingFace Dataset &rarr;
          </a>
        </div>
      </div>

      <div className="p-6">
        {/* Episode selector */}
        <div className="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1">
          {episodes.map((ep, i) => (
            <EpisodeCard
              key={ep.episodeIndex}
              episode={ep}
              selected={selectedIndex === i}
              onClick={() => {
                setPlaying(false);
                setSelectedIndex(i);
              }}
            />
          ))}
        </div>

        {/* Video grid */}
        {selectedEpisode ? (
          <div className="mt-5">
            {/* Episode info bar */}
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
              datasetId={datasetId}
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
