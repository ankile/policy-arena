import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { StatusBadge, StatusSelect } from "./StatusBadge";
import type { Id } from "../../convex/_generated/dataModel";
import {
  fetchEpisodeSubset,
  getParquetCache,
  selectPrimaryCameraKey,
  type EpisodeMetadata,
} from "../lib/hf-api";
import { useSearchParam, useSearchParamNullable, useSearchParamNumber, clearSearchParams } from "../lib/useSearchParam";
import {
  formatIdList,
  parseIdList,
  sessionLetter,
  toggleId,
} from "../lib/joinSessions";
import JoinedSessions, { type SessionListRow } from "./JoinedSessions";
import { RoundVideos } from "./RoundVideos";
import { roundVideoSpecs } from "../lib/roundVideoSpecs";
import { TONE_PILL, episodeScore, meanScore, outcomeLabel, outcomeTone } from "../lib/outcomeScore";
import { formatPValue, pairedRows, type PairedRow } from "../lib/pairedStats";

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
    rollout: "bg-purple-100 text-purple-700",
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${styles[mode] ?? "bg-warm-100 text-ink-muted"}`}
    >
      {mode}
    </span>
  );
}

function WdlRecord({
  wins,
  draws,
  losses,
  title,
}: {
  wins: number;
  draws: number;
  losses: number;
  title: string;
}) {
  return (
    <span className="flex items-center gap-1.5 font-mono whitespace-nowrap" title={title}>
      <span className="text-teal font-medium">{wins}W</span>
      <span className="text-ink-muted">{draws}D</span>
      <span className="text-coral font-medium">{losses}L</span>
    </span>
  );
}

const WIKI = {
  paired: "https://en.wikipedia.org/wiki/Paired_difference_test",
  bootstrap: "https://en.wikipedia.org/wiki/Bootstrapping_(statistics)",
  sign: "https://en.wikipedia.org/wiki/Sign_test",
  mcnemar: "https://en.wikipedia.org/wiki/McNemar%27s_test",
  permutation: "https://en.wikipedia.org/wiki/Permutation_test",
};

function WikiLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-teal hover:underline whitespace-nowrap"
    >
      {children} ↗
    </a>
  );
}

/**
 * Faint "?" next to the drawer toggle. The definitions card shows on hover
 * and can be pinned by click (touch, or to follow a link comfortably).
 */
function PairedStatsHelp() {
  const [pinned, setPinned] = useState(false);
  const dt = "font-mono text-ink shrink-0 w-14";
  const dd = "text-ink-muted";
  return (
    <span className="relative group inline-flex">
      <button
        onClick={() => setPinned((v) => !v)}
        aria-label="How the paired tests are computed"
        aria-expanded={pinned}
        className={`w-3.5 h-3.5 rounded-full border text-[9px] leading-none font-medium flex items-center justify-center cursor-pointer transition-colors ${
          pinned
            ? "border-ink-muted text-ink-muted"
            : "border-warm-300 text-warm-400 group-hover:border-ink-muted group-hover:text-ink-muted"
        }`}
      >
        ?
      </button>
      <div
        className={`absolute left-0 top-full z-20 pt-1.5 w-[30rem] max-w-[calc(100vw-4rem)] ${
          pinned ? "block" : "hidden group-hover:block"
        }`}
      >
        <div className="rounded-lg border border-warm-200 bg-white shadow-lg px-3 py-2.5 text-[11px] font-body leading-snug">
          <div className="text-ink mb-1.5">
            Every row is a{" "}
            <WikiLink href={WIKI.paired}>paired comparison</WikiLink>: round k of A is
            compared with round k of B (same start state), never A's pool against B's.
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            <dt className={dt}>n</dt>
            <dd className={dd}>
              Rounds where both arms have a result. Score rows also require a mark
              count on both.
            </dd>
            <dt className={dt}>Δ A−B</dt>
            <dd className={dd}>
              Mean over paired rounds of A's outcome minus B's: percentage points for
              success, score points for the graded score.
            </dd>
            <dt className={dt}>95% CI</dt>
            <dd className={dd}>
              Paired <WikiLink href={WIKI.bootstrap}>bootstrap</WikiLink>: resample
              rounds with replacement 20,000 times, recompute Δ each time, take the
              2.5th and 97.5th percentiles.
            </dd>
            <dt className={dt}>W/D/L</dt>
            <dd className={dd}>Rounds where A &gt; B, A = B, A &lt; B.</dd>
            <dt className={dt}>sign p</dt>
            <dd className={dd}>
              Exact two-sided <WikiLink href={WIKI.sign}>sign test</WikiLink> on the
              W and L counts (draws dropped): under H₀ each discordant round is a fair
              coin, p = P(a split at least this lopsided). For binary success this is
              identical to the exact{" "}
              <WikiLink href={WIKI.mcnemar}>McNemar test</WikiLink>, which uses the
              same two discordant cells.
            </dd>
            <dt className={dt}>flip p</dt>
            <dd className={dd}>
              Sign-flip <WikiLink href={WIKI.permutation}>permutation test</WikiLink>{" "}
              of mean Δ = 0: under H₀ each round's difference is equally likely to
              have the opposite sign, so flip signs at random 20,000 times and take
              p = share of flips with |mean| ≥ observed (with +1 correction). Unlike
              the sign test it weighs the size of each difference, so it can disagree
              with sign p when a few rounds swing by 2 points.
            </dd>
          </dl>
          <div className="mt-1.5 text-ink-muted">Bold p: p &lt; 0.05.</div>
        </div>
      </div>
    </span>
  );
}

function PairedStatsTable({
  rows,
  policyNames,
  maxMarks,
}: {
  rows: PairedRow[];
  policyNames: Map<string, string>;
  maxMarks: number;
}) {
  const th = "px-2 py-1 text-[10px] uppercase tracking-wider text-ink-muted font-medium whitespace-nowrap";
  const td = "px-2 py-1 font-mono text-xs text-ink whitespace-nowrap";
  const anyDropped = rows.some((r) => r.droppedUnscored > 0);
  return (
    <div className="mt-2 rounded-lg border border-warm-200 bg-warm-50/40 overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-warm-200">
          <tr>
            <th className={th}>A vs B</th>
            <th className={th}>Metric</th>
            <th className={`${th} text-right`}>n</th>
            <th className={`${th} text-right`}>A</th>
            <th className={`${th} text-right`}>B</th>
            <th className={`${th} text-right`} title="Paired per-round difference, mean(A) - mean(B)">
              Δ A−B
            </th>
            <th className={th} title="Paired bootstrap 95% CI on Δ (20,000 resamples of rounds)">
              95% CI
            </th>
            <th className={th} title="Rounds where A beat / tied / lost to B">
              W/D/L
            </th>
            <th
              className={`${th} text-right`}
              title="Exact two-sided sign test on the discordant rounds (= exact McNemar for binary success)"
            >
              sign p
            </th>
            <th
              className={`${th} text-right`}
              title="Two-sided sign-flip permutation test of mean Δ = 0 (20,000 flips); weighs the size of each round's difference"
            >
              flip p
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const nameA = policyNames.get(row.policyA) ?? row.policyA;
            const nameB = policyNames.get(row.policyB) ?? row.policyB;
            const isScore = row.metric === "score";
            const fmt = (x: number) => (isScore ? x.toFixed(2) : `${(x * 100).toFixed(0)}%`);
            const fmtDelta = (x: number) =>
              isScore
                ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}`
                : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)} pp`;
            const s = row.stats;
            return (
              <tr key={`${row.policyA}:${row.policyB}:${row.metric}`} className="border-b border-warm-100 last:border-b-0">
                <td className={`${td} font-body max-w-[16rem]`}>
                  <span className="flex items-baseline gap-1 min-w-0">
                    <span className="truncate" title={nameA}>{nameA}</span>
                    <span className="text-ink-muted shrink-0">vs</span>
                    <span className="truncate" title={nameB}>{nameB}</span>
                  </span>
                </td>
                <td className={`${td} font-body text-ink-muted`}>
                  {isScore ? `score 0–${maxMarks + 1}` : "success"}
                  {row.droppedUnscored > 0 ? "*" : ""}
                </td>
                {s === null ? (
                  <td className={`${td} text-ink-muted`} colSpan={8}>
                    no paired rounds
                  </td>
                ) : (
                  <>
                    <td className={`${td} text-right`}>{s.n}</td>
                    <td className={`${td} text-right`}>{fmt(s.meanA)}</td>
                    <td className={`${td} text-right`}>{fmt(s.meanB)}</td>
                    <td className={`${td} text-right font-medium`}>{fmtDelta(s.delta)}</td>
                    <td className={`${td} text-ink-muted`}>
                      [{fmtDelta(s.ciLo)}, {fmtDelta(s.ciHi)}]
                    </td>
                    <td className={td}>
                      <WdlRecord
                        wins={s.wins}
                        draws={s.draws}
                        losses={s.losses}
                        title={`${nameA} record vs ${nameB}`}
                      />
                    </td>
                    <td className={`${td} text-right ${s.signPValue < 0.05 ? "font-semibold" : ""}`}>
                      {formatPValue(s.signPValue)}
                    </td>
                    <td className={`${td} text-right ${s.signFlipPValue < 0.05 ? "font-semibold" : ""}`}>
                      {formatPValue(s.signFlipPValue)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyDropped && (
        <div className="px-2 py-1.5 text-[10px] text-ink-muted font-body border-t border-warm-200">
          * Score rows use only rounds where both arms carry a mark count.
        </div>
      )}
    </div>
  );
}

function SessionDetail({ sessionId }: { sessionId: Id<"evalSessions"> }) {
  const detail = useQuery(api.evalSessions.getDetail, { id: sessionId });
  const [expandedRound, setExpandedRound] = useSearchParamNumber("round");
  const [expandAll, setExpandAll] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // 20k bootstrap + 20k sign-flip resamples per row: only when the drawer is
  // open, and only once per detail payload.
  const pairedTable = useMemo<PairedRow[] | null>(
    () =>
      detail && statsOpen
        ? pairedRows(
            detail.policies.map((p) => p._id as string),
            detail.rounds,
            detail.max_subtask_marks,
          )
        : null,
    [detail, statsOpen],
  );
  const [datasetInfo, setDatasetInfo] = useState<{
    episodeMap: Map<number, Omit<EpisodeMetadata, "success">>;
    cameraKey: string;
  } | null>(() => {
    // Initialize from module-level cache if available
    if (!detail) return null;
    const cached = getParquetCache().get(detail.dataset_repo);
    if (!cached) return null;
    const episodeMap = new Map<number, Omit<EpisodeMetadata, "success">>();
    for (const ep of cached.episodes) episodeMap.set(ep.episodeIndex, ep);
    const cameraKey = selectPrimaryCameraKey(cached.cameraKeys);
    return { episodeMap, cameraKey };
  });
  const [datasetError, setDatasetError] = useState(false);

  useEffect(() => {
    if (!detail || datasetInfo) return;
    const neededIndices = new Set(
      detail.rounds.flatMap((r) => r.results.map((res) => res.episode_index))
    );
    fetchEpisodeSubset(detail.dataset_repo, neededIndices)
      .then((info) => {
        const episodeMap = new Map<number, Omit<EpisodeMetadata, "success">>();
        for (const ep of info.episodes) {
          episodeMap.set(ep.episodeIndex, ep);
        }
        const cameraKey = selectPrimaryCameraKey(info.cameraKeys);
        setDatasetInfo({ episodeMap, cameraKey });
      })
      .catch(() => {
        setDatasetError(true);
      });
  }, [detail?.dataset_repo]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const maxMarks = detail.max_subtask_marks;
        const policyStats = new Map<
          string,
          {
            successes: number;
            wins: number;
            draws: number;
            losses: number;
            // Graded rounds (success + marks) for the 0..N+1 score column.
            graded: Array<{ success: boolean; marks: number | null }>;
            // Pairwise W/D/L on the graded score (a round where both arms
            // failed but only one reached a sub-goal is a graded win).
            scoreWins: number;
            scoreDraws: number;
            scoreLosses: number;
          }
        >();

        for (const policy of detail.policies) {
          policyStats.set(policy._id, {
            successes: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            graded: [],
            scoreWins: 0,
            scoreDraws: 0,
            scoreLosses: 0,
          });
        }

        for (const round of detail.rounds) {
          for (const result of round.results) {
            const stats = policyStats.get(result.policy_id)!;
            if (result.success) stats.successes += 1;
            stats.graded.push({ success: result.success, marks: result.num_subtask_marks });
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
              if (maxMarks > 0) {
                const scoreA = episodeScore(a.success, a.num_subtask_marks);
                const scoreB = episodeScore(b.success, b.num_subtask_marks);
                if (scoreA > scoreB) {
                  statsA.scoreWins += 1;
                  statsB.scoreLosses += 1;
                } else if (scoreA < scoreB) {
                  statsA.scoreLosses += 1;
                  statsB.scoreWins += 1;
                } else {
                  statsA.scoreDraws += 1;
                  statsB.scoreDraws += 1;
                }
              }
            }
          }
        }

        return (
          <div className={`grid gap-3 mb-4 ${detail.policies.length === 2 ? "grid-cols-2" : detail.policies.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
            {detail.policies.map((policy) => {
              const stats = policyStats.get(policy._id)!;
              const successRate = totalRounds > 0 ? (stats.successes / totalRounds) * 100 : 0;
              const score = meanScore(stats.graded, maxMarks);
              const unscored = stats.graded.filter((g) => g.marks === null).length;

              return (
                <div
                  key={policy._id}
                  className="rounded-xl border border-warm-200 bg-warm-50/50 px-4 py-3"
                >
                  <div className="font-body font-semibold text-ink text-sm truncate mb-1.5" title={policy.name}>
                    {policy.name}
                  </div>
                  {/* One metric per line: label | value | pairwise record. */}
                  <div className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1 text-xs">
                    <span className="text-[11px] text-ink-muted font-body">success</span>
                    <span className="font-mono text-ink">{successRate.toFixed(0)}%</span>
                    <WdlRecord
                      wins={stats.wins}
                      draws={stats.draws}
                      losses={stats.losses}
                      title="Pairwise record on binary success"
                    />
                    {score !== null && (
                      <>
                        <span
                          className="text-[11px] text-ink-muted font-body"
                          title={
                            `Mean graded score: sub-goal marks reached + success, ` +
                            `max ${maxMarks + 1} per round` +
                            (unscored > 0
                              ? ` (${unscored} round(s) submitted without a mark count)`
                              : "")
                          }
                        >
                          score{unscored > 0 ? "*" : ""}
                        </span>
                        <span className="font-mono text-ink">
                          {score.toFixed(2)}
                          <span className="text-ink-muted"> / {maxMarks + 1}</span>
                        </span>
                        <WdlRecord
                          wins={stats.scoreWins}
                          draws={stats.scoreDraws}
                          losses={stats.scoreLosses}
                          title={`Pairwise record on the graded 0..${maxMarks + 1} score`}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Paired-test drawer: per policy pair, the paired per-round delta with
          a bootstrap CI and the two paired tests the Python pairwise summary
          reports (exact sign / McNemar, sign-flip permutation). */}
      <div className="mb-4 -mt-1">
        <div className="flex items-center gap-2">
        <button
          onClick={() => setStatsOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink transition-colors cursor-pointer"
          aria-expanded={statsOpen}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${statsOpen ? "rotate-90" : ""}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Paired tests
        </button>
        {statsOpen && <PairedStatsHelp />}
        </div>
        {statsOpen && pairedTable && (
          <PairedStatsTable
            rows={pairedTable}
            policyNames={new Map(detail.policies.map((p) => [p._id as string, p.name]))}
            maxMarks={detail.max_subtask_marks}
          />
        )}
      </div>

      {/* Rounds */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
          Rounds
        </span>
        {datasetInfo && (
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
        )}
      </div>
      {/* One grid row per round: Round | one cell per policy (session order,
          matching the cards above) | chevron. Policy names live in the header
          row, so a pill only carries the outcome and never wraps. */}
      {(() => {
        const columns = detail.policies.map((p) => ({ policy_id: p._id as string, name: p.name }));
        const known = new Set(columns.map((c) => c.policy_id));
        for (const round of detail.rounds) {
          for (const result of round.results) {
            if (!known.has(result.policy_id)) {
              known.add(result.policy_id);
              columns.push({ policy_id: result.policy_id, name: result.policyName });
            }
          }
        }
        const gridStyle = {
          gridTemplateColumns: `4.5rem repeat(${columns.length}, minmax(0, 1fr)) 0.75rem`,
        };
        return (
      <div className="space-y-2">
        <div className="grid items-center gap-x-2 px-3" style={gridStyle}>
          <span className="text-[10px] uppercase tracking-wider text-ink-muted/70 font-medium">
            Round
          </span>
          {columns.map((c) => (
            <span
              key={c.policy_id}
              className="text-[11px] font-mono text-ink-light truncate"
              title={c.name}
            >
              {c.name}
            </span>
          ))}
          <span />
        </div>
        {detail.rounds.map((round) => {
          const isExpanded = expandAll || expandedRound === round.index;
          const byPolicy = new Map(round.results.map((r) => [r.policy_id, r]));

          return (
            <div
              key={round.index}
              className="rounded-lg bg-warm-50/50 overflow-hidden"
            >
              <button
                onClick={() => {
                  if (expandAll) return;
                  setExpandedRound(isExpanded ? null : round.index);
                }}
                className="w-full grid items-center gap-x-2 px-3 py-2 hover:bg-warm-50 transition-colors cursor-pointer text-left"
                style={gridStyle}
              >
                <span className="text-xs font-mono text-ink-muted">
                  Round {round.index}
                </span>
                {columns.map((c) => {
                  const result = byPolicy.get(c.policy_id);
                  if (!result) {
                    return (
                      <span key={c.policy_id} className="text-[11px] text-ink-muted/50 px-2">
                        —
                      </span>
                    );
                  }
                  return (
                    <span
                      key={c.policy_id}
                      className={`block truncate px-2 py-0.5 rounded text-[11px] font-medium text-center ${
                        TONE_PILL[outcomeTone(result.success, result.num_subtask_marks)]
                      }`}
                      title={`${c.name} — episode ${result.episode_index}`}
                    >
                      {outcomeLabel(
                        result.success,
                        result.num_subtask_marks,
                        detail.max_subtask_marks
                      )}
                    </span>
                  );
                })}
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
                {!datasetInfo && <span />}
              </button>

              {isExpanded && datasetInfo && (
                <div className="px-3 pb-3">
                  <RoundVideos
                    videos={roundVideoSpecs(
                      round.results,
                      detail.dataset_repo,
                      datasetInfo.episodeMap,
                      datasetInfo.cameraKey,
                      undefined,
                      detail.max_subtask_marks,
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
        );
      })()}

      {datasetError && (
        <p className="text-xs text-ink-muted mt-3">
          Video previews unavailable (dataset not found on HuggingFace).
        </p>
      )}
    </div>
  );
}

type SessionModeFilter = "all" | "manual" | "pool-sample" | "calibrate" | "rollout";

const SESSION_MODE_FILTERS: { id: SessionModeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "manual", label: "Manual" },
  { id: "pool-sample", label: "Pool Sample" },
  { id: "calibrate", label: "Calibrate" },
  { id: "rollout", label: "Rollout" },
];

export default function EvalSessions() {
  const sessions = useQuery(api.evalSessions.list);
  const viewer = useQuery(api.users.viewer);
  const setSessionStatus = useMutation(api.evalSessions.setStatus);
  const setSessionOperator = useMutation(api.evalSessions.setOperator);
  const operators = useQuery(api.operators.list);
  const [expandedSession, setExpandedSessionRaw] = useSearchParamNullable("session");
  const [modeFilter, setModeFilter] = useSearchParam("mode", "all");
  const [taskFilter, setTaskFilter] = useSearchParam("task", "all");
  const [showParam] = useSearchParam("show", "mainline");
  const showAll = showParam === "all";

  // "Join" selection: an ordered list of session ids (order = A/B/C letters)
  // in ?join=; ?view=join swaps the list for the round-aligned joined view.
  const [joinParam, setJoinParam] = useSearchParamNullable("join");
  const [view, setView] = useSearchParam("view", "list");
  const joinIds = parseIdList(joinParam);
  const joinedView = view === "join" && joinIds.length >= 2;
  const toggleJoin = (id: string) => {
    const next = toggleId(joinIds, id);
    if (next.length < 2 && view === "join") setView("list");
    setJoinParam(formatIdList(next));
  };
  const clearJoin = () => {
    if (view === "join") setView("list");
    clearSearchParams("hide");
    setJoinParam(null);
  };

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

  const sessionById = new Map<string, SessionListRow>(
    sessions.map((s) => [s._id as string, s]),
  );

  // Mainline/all lens applies before every other filter and count.
  const statusVisible = showAll
    ? sessions
    : sessions.filter((s) => s.effective_status === "mainline");

  const modeFiltered =
    modeFilter === "all"
      ? statusVisible
      : statusVisible.filter((s) => (s.session_mode ?? "manual") === modeFilter);

  const filteredSessions =
    taskFilter === "all"
      ? modeFiltered
      : modeFiltered.filter((s) => s.task === taskFilter);

  // Count sessions per mode for the filter badges
  const modeCounts = new Map<string, number>();
  for (const s of statusVisible) {
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
      {/* Join bar: selected sessions (A, B, ...) + enter/leave the joined view */}
      {joinIds.length > 0 && (
        <div className="bg-white rounded-2xl border border-gold/40 shadow-sm px-5 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
            Join sessions
          </span>
          {joinIds.map((id, i) => {
            const row = sessionById.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-lg bg-warm-100 px-2 py-1 text-xs"
              >
                <span className="w-4 h-4 rounded bg-gold text-white text-[10px] font-mono font-semibold flex items-center justify-center">
                  {sessionLetter(i)}
                </span>
                <span className="font-mono text-ink-light">
                  {row ? row.policyNames.join(" vs ") : id}
                </span>
                {row && (
                  <span className="text-ink-muted">{formatDate(row._creationTime)}</span>
                )}
                <button
                  onClick={() => toggleJoin(id)}
                  className="text-ink-muted hover:text-coral cursor-pointer ml-1 font-mono"
                  title="Remove from join"
                >
                  ×
                </button>
              </span>
            );
          })}
          {joinIds.length < 2 ? (
            <span className="text-xs text-ink-muted">
              Pick at least one more session to join.
            </span>
          ) : (
            <button
              onClick={() => setView(joinedView ? "list" : "join")}
              className="px-3 py-1.5 rounded-lg bg-teal text-white text-xs font-medium cursor-pointer hover:bg-teal/90 transition-colors"
            >
              {joinedView ? "← Back to session list" : "View joined rollouts →"}
            </button>
          )}
          <button
            onClick={clearJoin}
            className="text-xs text-ink-muted hover:text-ink cursor-pointer ml-auto"
          >
            Clear
          </button>
        </div>
      )}

      {joinedView ? (
        <JoinedSessions sessionIds={joinIds} sessionRows={sessionById} />
      ) : (
        <>
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
                ? statusVisible.length
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
                <StatusBadge
                  status={session.effective_status}
                  reason={session.status_reason}
                />
                {session.operator && (
                  <span
                    className="inline-block px-2 py-0.5 rounded-full bg-warm-100 text-ink-muted text-[11px] font-mono"
                    title="Operator — who physically ran this eval"
                  >
                    op: {session.operator}
                  </span>
                )}
                {(() => {
                  const pos = joinIds.indexOf(session._id as string);
                  const joined = pos >= 0;
                  return (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleJoin(session._id as string);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleJoin(session._id as string);
                        }
                      }}
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-mono transition-colors cursor-pointer ${
                        joined
                          ? "bg-gold text-white"
                          : "bg-warm-100 text-ink-muted hover:bg-gold-light hover:text-gold"
                      }`}
                      title="Join this session with another to view their rollouts side by side, round by round"
                    >
                      {joined ? `joined · ${sessionLetter(pos)}` : "+ join"}
                    </span>
                  );
                })()}
                <a
                  href={`?tab=explorer&dataset=${encodeURIComponent(session.dataset_repo)}`}
                  className="hover:text-teal transition-colors font-mono"
                  onClick={(e) => e.stopPropagation()}
                >
                  Data Explorer &rarr;
                </a>
                <a
                  href={`https://huggingface.co/datasets/${session.dataset_repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-teal transition-colors font-mono"
                  onClick={(e) => e.stopPropagation()}
                >
                  HuggingFace &rarr;
                </a>
                {session.derivedDatasetRepos?.map((repo) => (
                  <a
                    key={repo}
                    href={`?tab=explorer&dataset=${encodeURIComponent(repo)}`}
                    className="hover:text-teal transition-colors font-mono"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Training view &rarr;
                  </a>
                ))}
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

          {/* Editor status override */}
          {viewer?.isEditor && expandedSession === (session._id as string) && (
            <div className="px-6 pb-3 flex items-center gap-2 text-xs text-ink-muted">
              <span className="uppercase tracking-widest text-[10px] font-medium">
                Status
              </span>
              <StatusSelect
                value={session.status ?? "inherit"}
                onChange={(v) =>
                  setSessionStatus({ id: session._id, status: v })
                }
              />
              <StatusBadge
                status={session.effective_status}
                reason={session.status_reason}
              />
              <span className="uppercase tracking-widest text-[10px] font-medium ml-4">
                Operator
              </span>
              <select
                value={session.operator ?? ""}
                onChange={(e) =>
                  setSessionOperator({ id: session._id, operator: e.target.value })
                }
                className="rounded-lg border border-warm-200 bg-white px-2 py-1 text-xs text-ink cursor-pointer"
              >
                {!session.operator && <option value="">unset</option>}
                {(operators ?? []).map((op) => (
                  <option key={op.hf_username} value={op.hf_username}>
                    {op.hf_username}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Expanded detail */}
          {expandedSession === (session._id as string) && (
            <SessionDetail sessionId={session._id} />
          )}
        </div>
      ))
      )}
        </>
      )}
    </div>
  );
}
