import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { fetchDatasetInfo, type EpisodeMetadata } from "../lib/hf-api";
import {
  useSearchParam,
  useSearchParamNullable,
  useSearchParamNumber,
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

function EnvironmentTag({ env }: { env: string }) {
  const colors: Record<string, string> = {
    franka_pick_cube: "bg-teal-light text-teal",
    PushT: "bg-teal-light text-teal",
    BimanualInsertion: "bg-coral-light text-coral",
    PickAndPlace: "bg-gold-light text-gold",
  };
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-body font-medium ${colors[env] ?? "bg-warm-100 text-ink-muted"}`}
    >
      {env}
    </span>
  );
}

function WinRateBar({
  rateA,
  rateB,
}: {
  rateA: number;
  rateB: number;
}) {
  const pctA = Math.round(rateA * 100);
  const pctB = Math.round(rateB * 100);
  const drawPct = 100 - pctA - pctB;
  return (
    <div className="flex items-center gap-2 w-full">
      <span className="font-mono text-[11px] text-teal w-8 text-right">{pctA}%</span>
      <div className="flex-1 h-2 rounded-full bg-warm-100 overflow-hidden flex">
        <div
          className="h-full bg-teal transition-all duration-500"
          style={{ width: `${pctA}%` }}
        />
        <div
          className="h-full bg-warm-200 transition-all duration-500"
          style={{ width: `${drawPct}%` }}
        />
        <div
          className="h-full bg-coral transition-all duration-500"
          style={{ width: `${pctB}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-coral w-8">{pctB}%</span>
    </div>
  );
}

function PairingSessionDetail({
  datasetRepo,
  sessionMode,
  creationTime,
  rounds,
}: {
  datasetRepo: string;
  sessionMode: string;
  creationTime: number;
  rounds: Array<{
    index: number;
    results: Array<{
      policy_id: string;
      policyName: string;
      success: boolean;
      episode_index: number;
    }>;
  }>;
}) {
  const [expandedRound, setExpandedRound] = useSearchParamNumber("pRound");
  const [datasetInfo, setDatasetInfo] = useState<{
    episodeMap: Map<number, EpisodeMetadata>;
    cameraKey: string;
  } | null>(null);
  const [datasetError, setDatasetError] = useState(false);

  useEffect(() => {
    fetchDatasetInfo(datasetRepo)
      .then((info) => {
        const episodeMap = new Map<number, EpisodeMetadata>();
        for (const ep of info.episodes) {
          episodeMap.set(ep.episodeIndex, ep);
        }
        const cameraKey =
          info.cameraKeys.length > 1
            ? info.cameraKeys[info.cameraKeys.length - 1]
            : info.cameraKeys[0];
        setDatasetInfo({ episodeMap, cameraKey });
      })
      .catch(() => {
        setDatasetError(true);
      });
  }, [datasetRepo]);

  return (
    <div className="border border-warm-200 rounded-xl bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-warm-100 bg-warm-50/50 flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-ink-muted">{formatDate(creationTime)}</span>
          <SessionModeTag mode={sessionMode} />
          <a
            href={`https://huggingface.co/datasets/${datasetRepo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-teal transition-colors font-mono text-xs text-ink-muted"
            onClick={(e) => e.stopPropagation()}
          >
            {datasetRepo} &rarr;
          </a>
        </div>
        <span className="font-mono text-xs text-ink-muted">
          {rounds.length} rounds
        </span>
      </div>

      <div className="p-3 space-y-1.5">
        {rounds.map((round) => {
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
                    datasetRepo={datasetRepo}
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
        <p className="text-xs text-ink-muted px-4 pb-3">
          Video previews unavailable (dataset not found on HuggingFace).
        </p>
      )}
    </div>
  );
}

function PairingDetail({
  policyIdA,
  policyIdB,
}: {
  policyIdA: Id<"policies">;
  policyIdB: Id<"policies">;
}) {
  const detail = useQuery(api.pairings.detail, {
    policyIdA,
    policyIdB,
  });
  const [expandedSession, setExpandedSessionRaw] =
    useSearchParamNullable("pSession");

  const setExpandedSession = (id: string | null) => {
    if (id === null) clearSearchParams("pRound");
    setExpandedSessionRaw(id);
  };

  if (!detail) {
    return (
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 text-ink-muted text-sm">
          <div className="w-4 h-4 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          Loading pairing details...
        </div>
      </div>
    );
  }

  // Compute aggregate stats from detail sessions
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  for (const session of detail.sessions) {
    for (const round of session.rounds) {
      const resultA = round.results.find(
        (r) => r.policy_id === (policyIdA as string)
      );
      const resultB = round.results.find(
        (r) => r.policy_id === (policyIdB as string)
      );
      if (resultA && resultB) {
        if (resultA.success && !resultB.success) winsA++;
        else if (!resultA.success && resultB.success) winsB++;
        else draws++;
      }
    }
  }
  return (
    <div className="px-6 pb-5 space-y-4">
      {/* Head-to-head summary cards */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { policy: detail.policyA, wins: winsA, losses: winsB, label: "A" },
          { policy: detail.policyB, wins: winsB, losses: winsA, label: "B" },
        ].map(({ policy, wins, losses }) => (
          <div
            key={policy._id}
            className="rounded-xl border border-warm-200 bg-warm-50/50 px-4 py-3 flex items-center justify-between"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-body font-semibold text-ink text-sm truncate">
                {policy.name}
              </span>
              <span className="text-ink-muted font-mono text-xs shrink-0">
                ELO {Math.round(policy.elo)}
              </span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="flex items-center gap-1.5 text-xs font-mono">
                <span className="text-teal font-medium">{wins}W</span>
                <span className="text-ink-muted">{draws}D</span>
                <span className="text-coral font-medium">{losses}L</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sessions list */}
      <div className="space-y-3">
        <h4 className="text-xs uppercase tracking-widest text-ink-muted font-medium">
          Sessions ({detail.sessions.length})
        </h4>
        {detail.sessions.map((session) => {
          const isExpanded = expandedSession === (session._id as string);
          return (
            <div key={session._id}>
              <button
                onClick={() =>
                  setExpandedSession(
                    isExpanded ? null : (session._id as string)
                  )
                }
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-warm-50 transition-colors cursor-pointer text-left"
              >
                <span className="text-xs text-ink-muted">
                  {formatDate(session._creationTime)}
                </span>
                <SessionModeTag mode={session.session_mode} />
                <span className="font-mono text-xs text-ink-muted">
                  {session.rounds.length} rounds
                </span>
                <span className="font-mono text-[11px] text-ink-muted/60 truncate flex-1">
                  {session.dataset_repo}
                </span>
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
              </button>

              {isExpanded && (
                <div className="mt-2">
                  <PairingSessionDetail
                    datasetRepo={session.dataset_repo}
                    sessionMode={session.session_mode}
                    creationTime={session._creationTime}
                    rounds={session.rounds}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Pairings() {
  const [selectedEnv, setSelectedEnv] = useSearchParam("env", "all");
  const [policyFilter, setPolicyFilter] = useSearchParam("policyFilter", "all");
  const [expandedPairingA, setExpandedPairingARaw] =
    useSearchParamNullable("pairingA");
  const [expandedPairingB, setExpandedPairingBRaw] =
    useSearchParamNullable("pairingB");

  const setExpandedPairing = (a: string | null, b: string | null) => {
    if (a === null) clearSearchParams("pSession", "pRound");
    setExpandedPairingARaw(a);
    setExpandedPairingBRaw(b);
  };

  const envList = useQuery(api.policies.environments);
  const policyNames = useQuery(api.policies.listNames);
  const pairings = useQuery(api.pairings.list, {
    ...(selectedEnv !== "all" ? { environment: selectedEnv } : {}),
    ...(policyFilter !== "all"
      ? { policyId: policyFilter as Id<"policies"> }
      : {}),
  });

  // Filter policy names by selected environment for the dropdown
  const filteredPolicies = policyNames
    ? selectedEnv === "all"
      ? policyNames
      : policyNames.filter((p) => p.environment === selectedEnv)
    : [];

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
                  setPolicyFilter("all");
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

        {/* Policy dropdown */}
        <select
          value={policyFilter}
          onChange={(e) => setPolicyFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-warm-200 bg-white text-sm text-ink font-body cursor-pointer hover:border-warm-300 transition-colors"
        >
          <option value="all">All policies</option>
          {filteredPolicies.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Pairings list */}
      {pairings === undefined ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
          <div className="flex items-center justify-center gap-3 text-ink-muted">
            <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
            <span className="font-body">Loading pairings...</span>
          </div>
        </div>
      ) : pairings.length === 0 ? (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
          No pairings found for the current filters.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
          {pairings.map((pairing, i) => {
            const isExpanded =
              expandedPairingA === pairing.policyA._id &&
              expandedPairingB === pairing.policyB._id;

            return (
              <div key={`${pairing.policyA._id}:${pairing.policyB._id}`}>
                <div
                  className={`px-6 py-4 flex items-center gap-4 hover:bg-warm-50 transition-colors cursor-pointer ${
                    i < pairings.length - 1 && !isExpanded
                      ? "border-b border-warm-100"
                      : ""
                  }`}
                  style={{
                    animation: `slide-in-right 0.4s ease-out ${0.35 + i * 0.04}s both`,
                  }}
                  onClick={() =>
                    setExpandedPairing(
                      isExpanded ? null : pairing.policyA._id,
                      isExpanded ? null : pairing.policyB._id
                    )
                  }
                >
                  {/* Policy names */}
                  <div className="flex items-center gap-2 min-w-0 shrink-0">
                    <span className="font-body font-semibold text-ink text-[15px] truncate">
                      {pairing.policyA.name}
                    </span>
                    <span className="text-ink-muted text-xs font-medium">vs</span>
                    <span className="font-body font-semibold text-ink text-[15px] truncate">
                      {pairing.policyB.name}
                    </span>
                  </div>

                  {/* Environment tag */}
                  <EnvironmentTag env={pairing.policyA.environment} />

                  {/* W/D/L */}
                  <div className="font-mono text-sm text-ink-muted shrink-0">
                    <span className="text-teal">{pairing.stats.winsA}</span>
                    <span className="text-warm-300 mx-1">/</span>
                    <span className="text-ink-muted">{pairing.stats.draws}</span>
                    <span className="text-warm-300 mx-1">/</span>
                    <span className="text-coral">{pairing.stats.winsB}</span>
                  </div>

                  {/* Win rate bar */}
                  <div className="flex-1 min-w-[120px] max-w-[200px]">
                    <WinRateBar
                      rateA={pairing.stats.winRateA}
                      rateB={pairing.stats.winRateB}
                    />
                  </div>

                  {/* Rounds + sessions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                      {pairing.stats.totalRounds} rounds
                    </span>
                    <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                      {pairing.sessionCount} {pairing.sessionCount === 1 ? "session" : "sessions"}
                    </span>
                  </div>

                  {/* Chevron */}
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
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-warm-100">
                    <PairingDetail
                      policyIdA={pairing.policyA._id as Id<"policies">}
                      policyIdB={pairing.policyB._id as Id<"policies">}
                    />
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
