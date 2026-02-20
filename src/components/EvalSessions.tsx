import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  fetchDatasetInfo,
  type EpisodeMetadata,
} from "../lib/hf-api";
import { useSearchParam, useSearchParamNullable, useSearchParamNumber, clearSearchParams } from "../lib/useSearchParam";
import { RoundVideos } from "./RoundVideos";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SessionModeTag({ mode }: { mode: string }) {
  const styles: Record<string, string> = {
    manual: "bg-warm-100 text-ink-muted",
    "pool-sample": "bg-teal-light text-teal",
    calibrate: "bg-gold-light text-gold",
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${styles[mode] ?? "bg-warm-100 text-ink-muted"}`}
    >
      {mode}
    </span>
  );
}

function SessionDetail({ sessionId }: { sessionId: Id<"evalSessions"> }) {
  const detail = useQuery(api.evalSessions.getDetail, { id: sessionId });
  const [expandedRound, setExpandedRound] = useSearchParamNumber("round");
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
      {/* Per-policy stats summary */}
      {(() => {
        const totalRounds = detail.rounds.length;
        const policyStats = new Map<
          string,
          { successes: number; wins: number; draws: number; losses: number }
        >();

        for (const policy of detail.policies) {
          policyStats.set(policy._id, {
            successes: 0,
            wins: 0,
            draws: 0,
            losses: 0,
          });
        }

        for (const round of detail.rounds) {
          for (const result of round.results) {
            if (result.success) {
              policyStats.get(result.policy_id)!.successes += 1;
            }
          }

          // Pairwise comparisons
          for (let i = 0; i < round.results.length; i++) {
            for (let j = i + 1; j < round.results.length; j++) {
              const a = round.results[i];
              const b = round.results[j];
              const statsA = policyStats.get(a.policy_id)!;
              const statsB = policyStats.get(b.policy_id)!;

              if (a.success && !b.success) {
                statsA.wins += 1;
                statsB.losses += 1;
              } else if (!a.success && b.success) {
                statsA.losses += 1;
                statsB.wins += 1;
              } else {
                statsA.draws += 1;
                statsB.draws += 1;
              }
            }
          }
        }

        return (
          <div className={`grid gap-3 mb-4 ${detail.policies.length === 2 ? "grid-cols-2" : detail.policies.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
            {detail.policies.map((policy) => {
              const stats = policyStats.get(policy._id)!;
              const successRate = totalRounds > 0 ? (stats.successes / totalRounds) * 100 : 0;

              return (
                <div
                  key={policy._id}
                  className="rounded-xl border border-warm-200 bg-warm-50/50 px-4 py-3"
                >
                  <div className="font-body font-semibold text-ink text-sm truncate mb-1.5" title={policy.name}>
                    {policy.name}
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-ink-muted font-mono shrink-0">
                      ELO {Math.round(policy.elo)}
                    </span>
                    <span className="font-mono text-ink shrink-0">
                      {successRate.toFixed(0)}%
                      <span className="text-[11px] text-ink-muted font-body ml-1">
                        success
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5 font-mono shrink-0">
                      <span className="text-teal font-medium">{stats.wins}W</span>
                      <span className="text-ink-muted">{stats.draws}D</span>
                      <span className="text-coral font-medium">{stats.losses}L</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

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

type SessionModeFilter = "all" | "manual" | "pool-sample" | "calibrate";

const SESSION_MODE_FILTERS: { id: SessionModeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "manual", label: "Manual" },
  { id: "pool-sample", label: "Pool Sample" },
  { id: "calibrate", label: "Calibrate" },
];

export default function EvalSessions() {
  const sessions = useQuery(api.evalSessions.list);
  const [expandedSession, setExpandedSessionRaw] = useSearchParamNullable("session");
  const [modeFilter, setModeFilter] = useSearchParam("mode", "all");
  const [taskFilter, setTaskFilter] = useSearchParam("task", "all");

  const setExpandedSession = (id: string | null) => {
    if (id === null) clearSearchParams("round");
    setExpandedSessionRaw(id);
  };

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

  const modeFiltered =
    modeFilter === "all"
      ? sessions
      : sessions.filter((s) => (s.session_mode ?? "manual") === modeFilter);

  const filteredSessions =
    taskFilter === "all"
      ? modeFiltered
      : modeFiltered.filter((s) => s.task === taskFilter);

  // Count sessions per mode for the filter badges
  const modeCounts = new Map<string, number>();
  for (const s of sessions) {
    const mode = s.session_mode ?? "manual";
    modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
  }

  // Unique tasks for filter pills (from mode-filtered sessions)
  const allTasks = [...new Set(modeFiltered.map((s) => s.task).filter(Boolean) as string[])].sort();

  return (
    <div
      className="space-y-4"
      style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
    >
      {/* Filter bars */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Mode filter */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium mr-1">
            Mode
          </span>
          {SESSION_MODE_FILTERS.map((filter) => {
            const count =
              filter.id === "all"
                ? sessions.length
                : modeCounts.get(filter.id) ?? 0;
            const isActive = modeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => setModeFilter(filter.id)}
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

      {filteredSessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
          No {modeFilter} sessions found.
        </div>
      ) : (
        filteredSessions.map((session) => (
        <div
          key={session._id}
          className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden"
        >
          {/* Session header */}
          <button
            onClick={() =>
              setExpandedSession(
                expandedSession === (session._id as string) ? null : (session._id as string)
              )
            }
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-warm-50/50 transition-colors cursor-pointer text-left"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {session.policyNames.map((name, i) => (
                  <span
                    key={i}
                    className="rounded bg-warm-100 px-2 py-0.5 text-xs font-mono text-ink-light"
                  >
                    {name}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-3 text-xs text-ink-muted">
                <span>{formatDate(session._creationTime)}</span>
                <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                  {Number(session.num_rounds)} rounds
                </span>
                <SessionModeTag mode={session.session_mode ?? "manual"} />
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`text-ink-muted transition-transform duration-200 ${
                expandedSession === (session._id as string) ? "rotate-90" : ""
              }`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Notes */}
          {session.notes && expandedSession === (session._id as string) && (
            <div className="px-6 pb-2">
              <p className="text-xs text-ink-muted italic">{session.notes}</p>
            </div>
          )}

          {/* Expanded detail */}
          {expandedSession === (session._id as string) && (
            <SessionDetail sessionId={session._id} />
          )}
        </div>
      ))
      )}
    </div>
  );
}
