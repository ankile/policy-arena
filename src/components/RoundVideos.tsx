import { useState, useEffect, useRef, useCallback } from "react";
import { getVideoUrl, type EpisodeMetadata } from "../lib/hf-api";

export interface RoundResult {
  policy_id: string;
  policyName: string;
  success: boolean;
  episode_index: number;
}

export function RoundVideos({
  results,
  datasetRepo,
  episodeMap,
  cameraKey,
}: {
  results: RoundResult[];
  datasetRepo: string;
  episodeMap: Map<number, EpisodeMetadata>;
  cameraKey: string;
}) {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(false);
  const animFrameRef = useRef<number>(0);

  const togglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  const resetVideos = useCallback(() => {
    setPlaying(false);
    for (let i = 0; i < videoRefs.current.length; i++) {
      const video = videoRefs.current[i];
      const episode = episodeMap.get(results[i]?.episode_index);
      if (video && episode) {
        video.pause();
        video.currentTime = episode.fromTimestamp;
      }
    }
  }, [results, episodeMap]);

  useEffect(() => {
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];

    if (playing) {
      for (const v of videos) v.play();

      const sync = () => {
        let allDone = true;
        for (let i = 0; i < videos.length; i++) {
          const episode = episodeMap.get(results[i]?.episode_index);
          if (episode && videos[i].currentTime >= episode.toTimestamp - 0.05) {
            videos[i].pause();
            videos[i].currentTime = episode.fromTimestamp;
          } else {
            allDone = false;
          }
        }
        if (allDone) {
          setPlaying(false);
          return;
        }
        animFrameRef.current = requestAnimationFrame(sync);
      };
      animFrameRef.current = requestAnimationFrame(sync);
    } else {
      for (const v of videos) v.pause();
    }

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [playing, results, episodeMap]);

  return (
    <div className="mt-3 mb-1">
      <div className={`grid gap-3 ${results.length === 2 ? "grid-cols-2" : results.length === 3 ? "grid-cols-3" : "grid-cols-4"}`}>
        {results.map((result, i) => {
          const episode = episodeMap.get(result.episode_index);
          if (!episode) {
            return (
              <div
                key={i}
                className="rounded-lg bg-warm-100 aspect-video flex items-center justify-center text-ink-muted text-xs"
              >
                No video data
              </div>
            );
          }

          return (
            <div key={i} className="relative">
              <video
                ref={(el) => {
                  videoRefs.current[i] = el;
                }}
                src={getVideoUrl(
                  cameraKey,
                  episode.videoFileIndex,
                  datasetRepo
                )}
                className="w-full rounded-lg bg-warm-100"
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  (e.target as HTMLVideoElement).currentTime =
                    episode.fromTimestamp;
                }}
              />
              <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded bg-black/60 text-white text-[11px] font-mono">
                  {result.policyName}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    result.success
                      ? "bg-emerald-500/80 text-white"
                      : "bg-red-500/80 text-white"
                  }`}
                >
                  {result.success ? "PASS" : "FAIL"}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-black/40 text-white/80 text-[10px] font-mono">
                  {episode.numFrames} steps
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-center gap-3 mt-3">
        <button
          onClick={togglePlay}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-teal text-white font-body font-medium text-xs hover:bg-teal/90 transition-colors cursor-pointer"
        >
          {playing ? (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={resetVideos}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-warm-200 text-ink-muted font-body text-xs hover:bg-warm-50 transition-colors cursor-pointer"
        >
          <svg
            width="12"
            height="12"
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
