import { useEffect, useMemo, useState } from "react";
import { useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  fetchEpisodeSubset,
  getParquetCache,
  selectPrimaryCameraKey,
  type EpisodeMetadata,
} from "../lib/hf-api";
import { useSearchParamNullable, useSearchParamNumber } from "../lib/useSearchParam";
import {
  alignRounds,
  alignmentSummary,
  formatIdList,
  hidePolicies,
  joinedPolicies,
  parseIdList,
  sessionLetter,
  sideSuccessSummary,
  toggleId,
  type JoinSide,
} from "../lib/joinSessions";
import { RoundVideos } from "./RoundVideos";
import { roundVideoSpecs, type RoundVideoSpec } from "../lib/roundVideoSpecs";
import { StatusBadge } from "./StatusBadge";

type SessionDetail = NonNullable<
  FunctionReturnType<typeof api.evalSessions.getDetail>
>;
export type SessionListRow = FunctionReturnType<
  typeof api.evalSessions.list
>[number];

type DsCacheEntry =
  | { status: "loading" }
  | {
      status: "loaded";
      episodeMap: Map<number, Omit<EpisodeMetadata, "success">>;
      cameraKey: string;
    }
  | { status: "error"; message: string };

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A round's tiles share one row when there are at most this many; beyond
// that each session gets its own column-aligned row.
const SINGLE_ROW_MAX_TILES = 4;

const SIDE_GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

/**
 * Side-by-side view of N eval sessions aligned on round index: round k of
 * session A next to round k of session B (and C, ...). Each aligned round
 * expands into one synchronized video grid holding every rollout from every
 * session, so a whole eval can be scanned rollout-by-rollout across sessions
 * that were never submitted together (different datasets, dates, policies).
 */
export default function JoinedSessions({
  sessionIds,
  sessionRows,
}: {
  sessionIds: string[];
  sessionRows: Map<string, SessionListRow>;
}) {
  const joinKey = sessionIds.join(",");
  const detailQueries = useMemo(() => {
    const queries: Record<
      string,
      { query: typeof api.evalSessions.getDetail; args: { id: Id<"evalSessions"> } }
    > = {};
    for (const id of sessionIds) {
      queries[id] = {
        query: api.evalSessions.getDetail,
        args: { id: id as Id<"evalSessions"> },
      };
    }
    return queries;
  }, [joinKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const details = useQueries(detailQueries) as Record<
    string,
    SessionDetail | null | undefined | Error
  >;

  const [expandedRound, setExpandedRound] = useSearchParamNumber("round");
  const [expandAll, setExpandAll] = useState(false);

  // Policies hidden from the side-by-side rounds (pills + video tiles), by
  // policy id, so a joined eval can be narrowed to the models being compared.
  // Lives in ?hide= so a filtered view is shareable.
  const [hideParam, setHideParam] = useSearchParamNullable("hide");
  const hiddenPolicyIds = new Set(parseIdList(hideParam));
  const toggleHidden = (policyId: string) =>
    setHideParam(formatIdList(toggleId(parseIdList(hideParam), policyId)));

  // Per-dataset episode metadata (sessions may live in different repos).
  const [datasetCache, setDatasetCache] = useState<Map<string, DsCacheEntry>>(
    () => {
      const initial = new Map<string, DsCacheEntry>();
      for (const [repo, cached] of getParquetCache()) {
        const episodeMap = new Map<number, Omit<EpisodeMetadata, "success">>();
        for (const ep of cached.episodes) episodeMap.set(ep.episodeIndex, ep);
        initial.set(repo, {
          status: "loaded",
          episodeMap,
          cameraKey: selectPrimaryCameraKey(cached.cameraKeys),
        });
      }
      return initial;
    },
  );

  const loadedDetails = sessionIds
    .map((id) => details[id])
    .filter((d): d is SessionDetail => d !== undefined && d !== null && !(d instanceof Error));
  const uniqueRepos = [...new Set(loadedDetails.map((d) => d.dataset_repo))];

  useEffect(() => {
    for (const repo of uniqueRepos) {
      if (datasetCache.has(repo)) continue;
      // Publish the in-flight cache entry before starting its async load.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDatasetCache((prev) => new Map(prev).set(repo, { status: "loading" }));
      const neededIndices = new Set(
        loadedDetails
          .filter((d) => d.dataset_repo === repo)
          .flatMap((d) => d.rounds.flatMap((r) => r.results.map((res) => res.episode_index))),
      );
      fetchEpisodeSubset(repo, neededIndices)
        .then((info) => {
          const episodeMap = new Map<number, Omit<EpisodeMetadata, "success">>();
          for (const ep of info.episodes) episodeMap.set(ep.episodeIndex, ep);
          setDatasetCache((prev) =>
            new Map(prev).set(repo, {
              status: "loaded",
              episodeMap,
              cameraKey: selectPrimaryCameraKey(info.cameraKeys),
            }),
          );
        })
        .catch((err: unknown) => {
          setDatasetCache((prev) =>
            new Map(prev).set(repo, { status: "error", message: String(err) }),
          );
        });
    }
  }, [uniqueRepos.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loading / error gates ──
  const pending = sessionIds.some((id) => details[id] === undefined);
  if (pending) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <div className="flex items-center justify-center gap-3 text-ink-muted">
          <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
          <span className="font-body">Loading joined sessions...</span>
        </div>
      </div>
    );
  }
  const problems = sessionIds.flatMap((id, i) => {
    const d = details[id];
    if (d instanceof Error) return [`Session ${sessionLetter(i)} (${id}): ${d.message}`];
    if (d === null) return [`Session ${sessionLetter(i)} (${id}) no longer exists — remove it from the join.`];
    return [];
  });
  if (problems.length > 0) {
    return (
      <div className="bg-white rounded-2xl border border-coral/40 shadow-sm p-6 space-y-1">
        {problems.map((p) => (
          <p key={p} className="text-sm text-coral font-mono">
            {p}
          </p>
        ))}
      </div>
    );
  }

  const sides: JoinSide[] = loadedDetails.map((d) => ({
    sessionId: d._id,
    rounds: d.rounds,
  }));
  const policies = joinedPolicies(sides);
  const rounds = hidePolicies(alignRounds(sides), hiddenPolicyIds);
  const hiddenCount = policies.filter((p) => hiddenPolicyIds.has(p.policy_id)).length;

  return (
    <div className="space-y-4">
      {/* Side summary cards */}
      <div className={`grid gap-3 ${SIDE_GRID[loadedDetails.length] ?? "grid-cols-4"}`}>
        {loadedDetails.map((detail, i) => {
          const row = sessionRows.get(detail._id);
          const summary = sideSuccessSummary(sides[i]);
          return (
            <div
              key={detail._id}
              className="bg-white rounded-2xl border border-warm-200 shadow-sm px-5 py-4"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-md bg-gold text-white text-xs font-mono font-semibold flex items-center justify-center">
                  {sessionLetter(i)}
                </span>
                <span className="text-xs text-ink-muted">
                  {formatDate(detail._creationTime)}
                </span>
                <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                  {detail.rounds.length} rounds
                </span>
                {row && (
                  <StatusBadge status={row.effective_status} reason={row.status_reason} />
                )}
                {detail.operator && (
                  <span className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono">
                    op: {detail.operator}
                  </span>
                )}
              </div>
              <div className="space-y-1 mb-2">
                {summary.map((s) => (
                  <div
                    key={s.policy_id}
                    className={`flex items-center gap-2 text-xs ${
                      hiddenPolicyIds.has(s.policy_id) ? "opacity-40 line-through" : ""
                    }`}
                  >
                    <span
                      className="rounded bg-warm-100 px-2 py-0.5 font-mono text-ink-light truncate"
                      title={s.policyName}
                    >
                      {s.policyName}
                    </span>
                    <span className="font-mono text-ink shrink-0">
                      {s.successes}/{s.rounds}
                      <span className="text-ink-muted ml-1">
                        ({s.rounds > 0 ? ((100 * s.successes) / s.rounds).toFixed(0) : "–"}%)
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <a
                href={`https://huggingface.co/datasets/${detail.dataset_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-ink-muted hover:text-teal transition-colors"
              >
                {detail.dataset_repo} &rarr;
              </a>
              {detail.notes && (
                <p className="text-xs text-ink-muted italic mt-1">{detail.notes}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Aligned rounds */}
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
        <div className="px-6 py-3 border-b border-warm-100 bg-warm-50 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
              Rounds aligned by index
            </span>
            <span className="font-mono text-xs text-ink-muted">
              {rounds.length} total · {alignmentSummary(rounds)}
            </span>
          </div>
          <button
            onClick={() => setExpandAll((v) => !v)}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
              expandAll
                ? "bg-teal text-white border-teal shadow-sm"
                : "bg-white text-ink-muted border-warm-200 hover:border-teal/40 hover:text-ink"
            }`}
          >
            {expandAll ? "Collapse all" : "Expand all rounds"}
          </button>
        </div>

        {/* Policy visibility: click a chip to hide/show that policy's pills + videos */}
        <div className="px-6 py-2 border-b border-warm-100 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
            Policies
          </span>
          {policies.map((policy) => {
            const hidden = hiddenPolicyIds.has(policy.policy_id);
            return (
              <button
                key={policy.policy_id}
                onClick={() => toggleHidden(policy.policy_id)}
                title={hidden ? "Show this policy" : "Hide this policy from the side-by-side rounds"}
                className={`px-2 py-0.5 rounded text-xs font-mono border transition-all cursor-pointer max-w-xs truncate ${
                  hidden
                    ? "bg-white text-ink-muted/60 border-warm-200 border-dashed line-through"
                    : "bg-warm-100 text-ink border-warm-200 hover:border-teal/40"
                }`}
              >
                {policy.policyName}
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              onClick={() => setHideParam(null)}
              className="text-[11px] text-teal hover:underline cursor-pointer ml-1"
            >
              show all ({hiddenCount} hidden)
            </button>
          )}
        </div>

        {rounds.map((round, i) => {
          const isExpanded = expandAll || expandedRound === round.index;
          // Per-side tile specs (sides whose metadata is missing get a note).
          const sideSpecs: RoundVideoSpec[][] = [];
          const notes: string[] = [];
          round.perSide.forEach((results, sideIdx) => {
            if (!results || results.length === 0) return;
            const detail = loadedDetails[sideIdx];
            const ds = datasetCache.get(detail.dataset_repo);
            if (ds?.status === "loaded") {
              sideSpecs.push(
                roundVideoSpecs(
                  results,
                  detail.dataset_repo,
                  ds.episodeMap,
                  ds.cameraKey,
                  sessionLetter(sideIdx),
                ),
              );
            } else if (ds?.status === "error") {
              notes.push(`${sessionLetter(sideIdx)}: video metadata failed — ${ds.message}`);
            } else {
              notes.push(`${sessionLetter(sideIdx)}: loading video metadata…`);
            }
          });
          // Layout: when every visible tile fits in one row, pack them all
          // into that row (the session letter badge tells them apart). Only
          // when there are more do we fall back to one row per session,
          // padded to the widest side so A's rollouts sit above B's,
          // column-aligned.
          const total = sideSpecs.reduce((n, specs) => n + specs.length, 0);
          const singleRow = total <= SINGLE_ROW_MAX_TILES;
          const columns = singleRow
            ? Math.max(1, total)
            : Math.max(1, ...sideSpecs.map((specs) => specs.length));
          const videos: (RoundVideoSpec | null)[] = [];
          for (const specs of sideSpecs) {
            videos.push(...specs);
            if (!singleRow) {
              for (let k = specs.length; k < columns; k++) videos.push(null);
            }
          }

          return (
            <div
              key={round.index}
              className={i < rounds.length - 1 ? "border-b border-warm-100" : ""}
            >
              <button
                onClick={() => {
                  if (expandAll) return;
                  setExpandedRound(isExpanded ? null : round.index);
                }}
                className="w-full flex items-center gap-3 px-6 py-2.5 hover:bg-warm-50 transition-colors cursor-pointer text-left"
              >
                <span className="text-xs font-mono text-ink-muted w-16 shrink-0">
                  Round {round.index}
                </span>
                <div className="flex items-center gap-3 flex-wrap flex-1">
                  {round.perSide.map((results, sideIdx) => (
                    <div
                      key={sideIdx}
                      className={`flex items-center gap-1.5 ${
                        sideIdx > 0 ? "pl-3 border-l border-warm-200" : ""
                      }`}
                    >
                      <span className="text-[10px] font-mono font-semibold text-gold w-3">
                        {sessionLetter(sideIdx)}
                      </span>
                      {results === null ? (
                        <span className="text-[11px] text-ink-muted/60 italic">
                          no round {round.index}
                        </span>
                      ) : results.length === 0 ? (
                        <span className="text-[11px] text-ink-muted/60 italic">
                          all hidden
                        </span>
                      ) : (
                        results.map((result, j) => (
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
                        ))
                      )}
                    </div>
                  ))}
                </div>
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
                <div className="px-6 pb-4">
                  {videos.some(Boolean) && (
                    <RoundVideos videos={videos} columns={columns} />
                  )}
                  {notes.map((note) => (
                    <p key={note} className="text-xs text-ink-muted mt-2 font-mono">
                      {note}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
