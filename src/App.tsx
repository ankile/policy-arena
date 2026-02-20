import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

import DataExplorer from "./components/DataExplorer";
import EvalSessions from "./components/EvalSessions";
import Pairings from "./components/Pairings";
import PolicyDetail from "./components/PolicyDetail";
import { useSearchParam, useSearchParamNullable, clearSearchParams } from "./lib/useSearchParam";

function winRate(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) return 0;
  return Math.round((wins / total) * 100);
}

const medalColors = [
  "from-amber-400 to-yellow-500",
  "from-gray-300 to-gray-400",
  "from-orange-400 to-amber-600",
];

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <div
        className={`w-8 h-8 rounded-full bg-gradient-to-br ${medalColors[rank - 1]} flex items-center justify-center text-white font-body font-semibold text-sm shadow-sm`}
      >
        {rank}
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full bg-warm-100 flex items-center justify-center text-ink-muted font-mono text-sm">
      {rank}
    </div>
  );
}

function WinRateBar({ wins, losses }: { wins: number; losses: number }) {
  const rate = winRate(wins, losses);
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 h-1.5 rounded-full bg-warm-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${rate}%`,
            backgroundColor:
              rate >= 50 ? "var(--color-emerald-bar)" : "var(--color-rose-bar)",
          }}
        />
      </div>
      <span className="font-mono text-xs text-ink-muted w-8">{rate}%</span>
    </div>
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

type Tab = "leaderboard" | "sessions" | "pairings" | "explorer";

type TabConfig = { id: Tab; label: string };

function App() {
  const [activeTab, setActiveTabRaw] = useSearchParam("tab", "leaderboard");
  const [selectedEnv, setSelectedEnv] = useSearchParam("env", "all");
  const [expandedPolicy, setExpandedPolicy] = useSearchParamNullable("policy");

  const envList = useQuery(api.policies.environments);
  const policies = useQuery(
    api.policies.leaderboard,
    selectedEnv === "all" ? {} : { environment: selectedEnv },
  );

  const setActiveTab = (tab: string) => {
    clearSearchParams("policy", "session", "mode", "round", "source", "task", "dataset", "episode", "outcome", "env", "policyA", "policyB", "pRound");
    setActiveTabRaw(tab);
  };

  const sortedPolicies = policies ?? [];
  const maxElo = sortedPolicies.length > 0 ? sortedPolicies[0].elo : 0;

  const tabs: TabConfig[] = [
    { id: "leaderboard", label: "Leaderboard" },
    { id: "sessions", label: "Eval Sessions" },
    { id: "pairings", label: "Pairings" },
    { id: "explorer", label: "Data Explorer" },
  ];

  return (
    <div className="min-h-screen bg-cream font-body text-ink">
      {/* Subtle top accent line */}
      <div className="h-1 bg-gradient-to-r from-teal via-gold to-coral" />

      <div className="max-w-6xl mx-auto px-6 py-16">
        {/* Header */}
        <header
          className="mb-14"
          style={{ animation: "fade-up 0.6s ease-out both" }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-teal to-teal/70 flex items-center justify-center">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 8V4H8" />
                <rect x="4" y="8" width="16" height="12" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <path d="M9 13v2" />
                <path d="M15 13v2" />
              </svg>
            </div>
            <h1 className="font-display text-4xl text-ink tracking-tight">
              Policy Arena
            </h1>
          </div>
          <p className="text-ink-muted font-body text-lg ml-[52px]">
            Track, compare, and rank robot learning policies and datasets
          </p>
        </header>

        {/* Tab navigation */}
        <div
          className="flex gap-1 mb-8 bg-warm-100 rounded-xl p-1 w-fit"
          style={{ animation: "fade-up 0.6s ease-out 0.1s both" }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer ${
                activeTab === tab.id
                  ? "bg-white text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "leaderboard" && (
          <>
            {/* Environment filter */}
            {envList && envList.length > 1 && (
              <div
                className="flex gap-2 mb-6 flex-wrap"
                style={{ animation: "fade-up 0.6s ease-out 0.12s both" }}
              >
                {["all", ...envList].map((env) => (
                  <button
                    key={env}
                    onClick={() => setSelectedEnv(env)}
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

            {/* Stats summary */}
            <div
              className="grid grid-cols-3 gap-4 mb-10"
              style={{ animation: "fade-up 0.6s ease-out 0.15s both" }}
            >
              {[
                {
                  label: "Policies",
                  value: sortedPolicies.length.toString(),
                },
                { label: "Top ELO", value: maxElo ? maxElo.toString() : "—" },
                {
                  label: "Comparisons",
                  value: Math.round(sortedPolicies
                    .reduce(
                      (a, p) =>
                        a + Number(p.wins) + Number(p.losses) + Number(p.draws),
                      0
                    ) / 2).toString(),
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-white rounded-xl border border-warm-200 px-5 py-4"
                >
                  <div className="text-xs uppercase tracking-widest text-ink-muted font-medium mb-1">
                    {stat.label}
                  </div>
                  <div className="font-display text-2xl text-ink">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Leaderboard */}
            {policies === undefined ? (
              <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
                <div className="flex items-center justify-center gap-3 text-ink-muted">
                  <div className="w-5 h-5 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
                  <span className="font-body">Loading leaderboard...</span>
                </div>
              </div>
            ) : sortedPolicies.length === 0 ? (
              <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted">
                No policies registered yet. Submit an eval session to get
                started.
              </div>
            ) : (
              <div
                className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden"
                style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
              >
                {/* Table header */}
                <div className="grid grid-cols-[56px_1fr_80px_130px_140px_80px_90px] px-6 py-3.5 border-b border-warm-100 bg-warm-50">
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    #
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    Policy
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    ELO
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    W / D / L
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    Win Rate
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    Success
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">
                    Avg Steps
                  </span>
                </div>

                {/* Rows */}
                {sortedPolicies.map(
                  (policy, i) => (
                    <div key={policy._id}>
                      <div
                        className={`grid grid-cols-[56px_1fr_80px_130px_140px_80px_90px] items-center px-6 py-4 transition-colors duration-150 hover:bg-warm-50 cursor-pointer ${
                          i < sortedPolicies.length - 1 &&
                          expandedPolicy !== (policy._id as string)
                            ? "border-b border-warm-100"
                            : ""
                        }`}
                        style={{
                          animation: `slide-in-right 0.4s ease-out ${0.35 + i * 0.04}s both`,
                        }}
                        onClick={() =>
                          setExpandedPolicy(
                            expandedPolicy === (policy._id as string)
                              ? null
                              : (policy._id as string)
                          )
                        }
                      >
                        {/* Rank */}
                        <div>
                          <RankBadge rank={i + 1} />
                        </div>

                        {/* Name + Environment */}
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="min-w-0 flex-1">
                            <div className="font-body font-semibold text-ink text-[15px] truncate" title={policy.name}>
                              {policy.name}
                            </div>
                            <div className="mt-1">
                              <EnvironmentTag env={policy.environment} />
                            </div>
                          </div>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className={`text-ink-muted/50 transition-transform duration-200 flex-shrink-0 ${
                              expandedPolicy === (policy._id as string)
                                ? "rotate-90"
                                : ""
                            }`}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </div>

                        {/* ELO */}
                        <div className="font-mono text-sm font-medium text-ink">
                          {Math.round(policy.elo)}
                        </div>

                        {/* W / D / L */}
                        <div className="font-mono text-sm text-ink-muted">
                          <span className="text-emerald-bar">
                            {Number(policy.wins)}
                          </span>
                          <span className="text-warm-300 mx-1">/</span>
                          <span className="text-ink-muted">
                            {Number(policy.draws)}
                          </span>
                          <span className="text-warm-300 mx-1">/</span>
                          <span className="text-rose-bar">
                            {Number(policy.losses)}
                          </span>
                        </div>

                        {/* Win Rate */}
                        <WinRateBar
                          wins={Number(policy.wins)}
                          losses={Number(policy.losses)}
                        />

                        {/* Success Rate */}
                        <div className="font-mono text-sm text-ink-muted">
                          {policy.successRate != null
                            ? `${Math.round(policy.successRate * 100)}%`
                            : "—"}
                        </div>

                        {/* Avg Steps */}
                        <div className="font-mono text-sm text-ink-muted">
                          {policy.avgSuccessSteps != null
                            ? policy.avgSuccessSteps
                            : "—"}
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {expandedPolicy === (policy._id as string) && (
                        <div className="border-b border-warm-100">
                          <PolicyDetail policyId={policy._id} />
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            )}
          </>
        )}

        {activeTab === "sessions" && <EvalSessions />}

        {activeTab === "pairings" && <Pairings />}

        {activeTab === "explorer" && <DataExplorer />}

        {/* Footer */}
        <footer
          className="mt-8 text-center text-xs text-ink-muted/60"
          style={{ animation: "fade-up 0.6s ease-out 0.9s both" }}
        >
          ELO ratings computed from pairwise policy evaluations
        </footer>
      </div>
    </div>
  );
}

export default App;
