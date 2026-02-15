import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  fetchDatasetInfo,
  getVideoUrl,
  type EpisodeMetadata,
} from "../lib/hf-api";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface RoundResult {
  policy_id: string;
  policyName: string;
  success: boolean;
  episode_index: number;
}

function RoundVideos({
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

function SessionDetail({ sessionId }: { sessionId: Id<"evalSessions"> }) {
  const detail = useQuery(api.evalSessions.getDetail, { id: sessionId });
  const [expandedRound, setExpandedRound] = useState<number | null>(null);
  const [datasetInfo, setDatasetInfo] = useState<{
    episodeMap: Map<number, EpisodeMetadata>;
    cameraKey: string;
  } | null>(null);
  const [datasetError, setDatasetError] = useState(false);

  useEffect(() => {
    if (!detail) return;
    fetchDatasetInfo(detail.dataset_repo)
      .then((info) => {
        const episodeMap = new Map<number, EpisodeMetadata>();
        for (const ep of info.episodes) {
          episodeMap.set(ep.episodeIndex, ep);
        }
        // Use last camera key (typically the better angle)
        const cameraKey =
          info.cameraKeys.length > 1
            ? info.cameraKeys[info.cameraKeys.length - 1]
            : info.cameraKeys[0];
        setDatasetInfo({ episodeMap, cameraKey });
      })
      .catch(() => {
        setDatasetError(true);
      });
  }, [detail?.dataset_repo]);

  if (!detail) {
    return (
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 text-ink-muted text-sm">
          <div className="w-4 h-4 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          Loading round details...
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pb-5">
      {/* Policy legend */}
      <div className="flex gap-3 mb-4">
        {detail.policies.map((policy) => (
          <span
            key={policy._id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-warm-50 border border-warm-200 text-xs font-medium text-ink"
          >
            {policy.name}
            <span className="text-ink-muted font-mono">
              ELO {Math.round(policy.elo)}
            </span>
          </span>
        ))}
      </div>

      {/* Rounds */}
      <div className="space-y-2">
        {detail.rounds.map((round) => {
          const isExpanded = expandedRound === round.index;

          return (
            <div
              key={round.index}
              className="rounded-lg bg-warm-50/50 overflow-hidden"
            >
              <button
                onClick={() =>
                  setExpandedRound(isExpanded ? null : round.index)
                }
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-warm-50 transition-colors cursor-pointer text-left"
              >
                <span className="text-xs font-mono text-ink-muted w-16 shrink-0">
                  Round {round.index}
                </span>
                <div className="flex gap-2 flex-wrap flex-1">
                  {round.results.map((result, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                        result.success
                          ? "bg-teal-light text-teal"
                          : "bg-coral-light text-coral"
                      }`}
                    >
                      {result.policyName}
                      <span className="text-[10px]">
                        {result.success ? "PASS" : "FAIL"}
                      </span>
                    </span>
                  ))}
                </div>
                {datasetInfo && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={`text-ink-muted/50 transition-transform duration-200 shrink-0 ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                )}
              </button>

              {isExpanded && datasetInfo && (
                <div className="px-3 pb-3">
                  <RoundVideos
                    results={round.results}
                    datasetRepo={detail.dataset_repo}
                    episodeMap={datasetInfo.episodeMap}
                    cameraKey={datasetInfo.cameraKey}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {datasetError && (
        <p className="text-xs text-ink-muted mt-3">
          Video previews unavailable (dataset not found on HuggingFace).
        </p>
      )}
    </div>
  );
}

export default function EvalSessions() {
  const sessions = useQuery(api.evalSessions.list);
  const [expandedSession, setExpandedSession] =
    useState<Id<"evalSessions"> | null>(null);

  if (sessions === undefined) {
    return (
      <div
        className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8"
        style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
      >
        <div className="flex items-center justify-center gap-3 text-ink-muted">
          <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          <span className="font-body">Loading eval sessions...</span>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div
        className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted"
        style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
      >
        No eval sessions yet. Submit one via the Python client to get started.
      </div>
    );
  }

  return (
    <div
      className="space-y-4"
      style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
    >
      {sessions.map((session) => (
        <div
          key={session._id}
          className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden"
        >
          {/* Session header */}
          <button
            onClick={() =>
              setExpandedSession(
                expandedSession === session._id ? null : session._id
              )
            }
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-warm-50/50 transition-colors cursor-pointer text-left"
          >
            <div className="flex items-center gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-body font-semibold text-ink text-[15px]">
                    {session.policyNames.join(" vs ")}
                  </span>
                  <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                    {Number(session.num_rounds)} rounds
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-ink-muted">
                  <span>{formatDate(session._creationTime)}</span>
                  <a
                    href={`https://huggingface.co/datasets/${session.dataset_repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-teal transition-colors font-mono"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {session.dataset_repo} &rarr;
                  </a>
                </div>
              </div>
            </div>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`text-ink-muted transition-transform duration-200 ${
                expandedSession === session._id ? "rotate-90" : ""
              }`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Notes */}
          {session.notes && expandedSession === session._id && (
            <div className="px-6 pb-2">
              <p className="text-xs text-ink-muted italic">{session.notes}</p>
            </div>
          )}

          {/* Expanded detail */}
          {expandedSession === session._id && (
            <SessionDetail sessionId={session._id} />
          )}
        </div>
      ))}
    </div>
  );
}
