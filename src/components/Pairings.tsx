import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { fetchDatasetInfo, type EpisodeMetadata } from "../lib/hf-api";
import {
  useSearchParam,
  useSearchParamNullable,
  clearSearchParams,
} from "../lib/useSearchParam";
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

export default function Pairings() {
  const [selectedEnv, setSelectedEnv] = useSearchParam("env", "all");
  const [policyA, setPolicyARaw] = useSearchParam("policyA", "all");
  const [policyB, setPolicyBRaw] = useSearchParam("policyB", "all");
  const [expandedRound, setExpandedRound] = useSearchParamNullable("pRound");

  const setPolicyA = (v: string) => {
    clearSearchParams("pRound");
    setPolicyARaw(v);
  };
  const setPolicyB = (v: string) => {
    clearSearchParams("pRound");
    setPolicyBRaw(v);
  };

  const envList = useQuery(api.policies.environments);
  const policyNames = useQuery(api.policies.listNames);

  const filteredPolicies = policyNames
    ? selectedEnv === "all"
      ? policyNames
      : policyNames.filter((p) => p.environment === selectedEnv)
    : [];

  // Query rounds only when a specific policy A is selected
  const rounds = useQuery(
    api.pairings.listRounds,
    policyA !== "all"
      ? {
          policyIdA: policyA as Id<"policies">,
          ...(policyB !== "all"
            ? { policyIdB: policyB as Id<"policies"> }
            : {}),
        }
      : "skip"
  );

  // Cache dataset info by repo
  const [datasetCache, setDatasetCache] = useState<
    Map<
      string,
      | { status: "loading" }
      | { status: "loaded"; episodeMap: Map<number, EpisodeMetadata>; cameraKey: string }
      | { status: "error" }
    >
  >(new Map());

  // Load dataset info for all unique repos in the current rounds
  const uniqueRepos = rounds
    ? [...new Set(rounds.map((r) => r.datasetRepo))]
    : [];

  useEffect(() => {
    for (const repo of uniqueRepos) {
      if (datasetCache.has(repo)) continue;
      setDatasetCache((prev) => new Map(prev).set(repo, { status: "loading" }));
      fetchDatasetInfo(repo)
        .then((info) => {
          const episodeMap = new Map<number, EpisodeMetadata>();
          for (const ep of info.episodes) {
            episodeMap.set(ep.episodeIndex, ep);
          }
          const cameraKey =
            info.cameraKeys.length > 1
              ? info.cameraKeys[info.cameraKeys.length - 1]
              : info.cameraKeys[0];
          setDatasetCache((prev) =>
            new Map(prev).set(repo, { status: "loaded", episodeMap, cameraKey })
          );
        })
        .catch(() => {
          setDatasetCache((prev) => new Map(prev).set(repo, { status: "error" }));
        });
    }
  }, [uniqueRepos.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="space-y-4"
      style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
    >
      {/* Filter bar */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Environment pills */}
        {envList && envList.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            {["all", ...envList].map((env) => (
              <button
                key={env}
                onClick={() => {
                  setSelectedEnv(env);
                  setPolicyA("all");
                  setPolicyB("all");
                }}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150 cursor-pointer border ${
                  selectedEnv === env
                    ? "bg-teal text-white border-teal shadow-sm"
                    : "bg-white text-ink-muted border-warm-200 hover:border-teal/40 hover:text-ink"
                }`}
              >
                {env === "all" ? "All Tasks" : env}
              </button>
            ))}
          </div>
        )}

        {/* Policy A dropdown (required) */}
        <select
          value={policyA}
          onChange={(e) => setPolicyA(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-warm-200 bg-white text-sm text-ink font-body cursor-pointer hover:border-warm-300 transition-colors"
        >
          <option value="all">Policy A</option>
          {filteredPolicies.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>

        {/* Policy B dropdown (optional) */}
        <select
          value={policyB}
          onChange={(e) => setPolicyB(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-warm-200 bg-white text-sm text-ink font-body cursor-pointer hover:border-warm-300 transition-colors"
        >
          <option value="all">Any opponent</option>
          {filteredPolicies
            .filter((p) => (p._id as string) !== policyA)
            .map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
        </select>
      </div>

      {/* Content */}
      {policyA === "all" ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
          Select a policy to view its head-to-head rounds.
        </div>
      ) : rounds === undefined ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
          <div className="flex items-center justify-center gap-3 text-ink-muted">
            <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
            <span className="font-body">Loading rounds...</span>
          </div>
        </div>
      ) : rounds.length === 0 ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
          No rounds found for the selected policies.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 py-3 border-b border-warm-100 bg-warm-50 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
              Rounds
            </span>
            <span className="font-mono text-xs text-ink-muted">
              {rounds.length} total
            </span>
          </div>

          {/* Rounds list */}
          {rounds.map((round, i) => {
            const roundKey = `${round.sessionId}:${round.roundIndex}`;
            const isExpanded = expandedRound === roundKey;
            const dsInfo = datasetCache.get(round.datasetRepo);
            const dsLoaded = dsInfo?.status === "loaded" ? dsInfo : null;

            return (
              <div
                key={roundKey}
                className={
                  i < rounds.length - 1 && !isExpanded
                    ? "border-b border-warm-100"
                    : ""
                }
              >
                <button
                  onClick={() =>
                    setExpandedRound(isExpanded ? null : roundKey)
                  }
                  className="w-full flex items-center gap-3 px-6 py-3 hover:bg-warm-50 transition-colors cursor-pointer text-left"
                  style={{
                    animation: `slide-in-right 0.4s ease-out ${0.35 + i * 0.02}s both`,
                  }}
                >
                  {/* Round index */}
                  <span className="text-xs font-mono text-ink-muted w-16 shrink-0">
                    Round {round.roundIndex}
                  </span>

                  {/* Pass/fail pills */}
                  <div className="flex gap-2 flex-wrap flex-1">
                    {round.results.map((result, j) => (
                      <span
                        key={j}
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

                  {/* Session metadata */}
                  <span className="text-[11px] text-ink-muted/70 shrink-0">
                    {formatDate(round.sessionCreationTime)}
                  </span>
                  <SessionModeTag mode={round.sessionMode} />
                  <a
                    href={`https://huggingface.co/datasets/${round.datasetRepo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-teal transition-colors font-mono text-[11px] text-ink-muted/60 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {round.datasetRepo.split("/").pop()}
                  </a>

                  {/* Chevron */}
                  {dsLoaded && (
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

                {/* Expanded video */}
                {isExpanded && dsLoaded && (
                  <div className="px-6 pb-4">
                    <RoundVideos
                      results={round.results.map((r) => ({
                        policy_id: r.policyId,
                        policyName: r.policyName,
                        success: r.success,
                        episode_index: r.episodeIndex,
                      }))}
                      datasetRepo={round.datasetRepo}
                      episodeMap={dsLoaded.episodeMap}
                      cameraKey={dsLoaded.cameraKey}
                    />
                  </div>
                )}

                {isExpanded && dsInfo?.status === "error" && (
                  <p className="text-xs text-ink-muted px-6 pb-3">
                    Video previews unavailable (dataset not found on HuggingFace).
                  </p>
                )}

                {isExpanded && dsInfo?.status === "loading" && (
                  <div className="px-6 pb-3 flex items-center gap-2 text-ink-muted text-xs">
                    <div className="w-3 h-3 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
                    Loading video data...
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
