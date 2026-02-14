type Policy = {
  name: string;
  elo: number;
  environment: string;
  wins: number;
  losses: number;
};

const policies: Policy[] = [
  { name: "DiffusionPolicy-v2", elo: 1847, environment: "PushT", wins: 142, losses: 38 },
  { name: "ACT-Large", elo: 1792, environment: "BimanualInsertion", wins: 128, losses: 52 },
  { name: "VQ-BeT", elo: 1756, environment: "PushT", wins: 119, losses: 61 },
  { name: "ACT-Small", elo: 1701, environment: "BimanualInsertion", wins: 105, losses: 75 },
  { name: "BC-Transformer", elo: 1683, environment: "PushT", wins: 98, losses: 82 },
  { name: "LSTM-GMM", elo: 1624, environment: "PickAndPlace", wins: 87, losses: 93 },
  { name: "IBC", elo: 1598, environment: "PushT", wins: 79, losses: 101 },
  { name: "BeT", elo: 1567, environment: "PickAndPlace", wins: 71, losses: 109 },
  { name: "MLP-MSE", elo: 1489, environment: "PushT", wins: 54, losses: 126 },
  { name: "RandomPolicy", elo: 1312, environment: "PushT", wins: 21, losses: 159 },
];

const sortedPolicies = [...policies].sort((a, b) => b.elo - a.elo);

const maxElo = sortedPolicies[0].elo;
const minElo = sortedPolicies[sortedPolicies.length - 1].elo;

function eloBarWidth(elo: number): number {
  return 20 + ((elo - minElo) / (maxElo - minElo)) * 80;
}

function winRate(wins: number, losses: number): number {
  return Math.round((wins / (wins + losses)) * 100);
}

const medalColors = [
  "from-amber-400 to-yellow-500",
  "from-gray-300 to-gray-400",
  "from-orange-400 to-amber-600",
];

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${medalColors[rank - 1]} flex items-center justify-center text-white font-body font-semibold text-sm shadow-sm`}>
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
            backgroundColor: rate >= 50 ? "var(--color-emerald-bar)" : "var(--color-rose-bar)",
          }}
        />
      </div>
      <span className="font-mono text-xs text-ink-muted w-8">{rate}%</span>
    </div>
  );
}

function EnvironmentTag({ env }: { env: string }) {
  const colors: Record<string, string> = {
    PushT: "bg-teal-light text-teal",
    BimanualInsertion: "bg-coral-light text-coral",
    PickAndPlace: "bg-gold-light text-gold",
  };
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-body font-medium ${colors[env] ?? "bg-warm-100 text-ink-muted"}`}>
      {env}
    </span>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-cream font-body text-ink">
      {/* Subtle top accent line */}
      <div className="h-1 bg-gradient-to-r from-teal via-gold to-coral" />

      <div className="max-w-4xl mx-auto px-6 py-16">
        {/* Header */}
        <header
          className="mb-14"
          style={{ animation: "fade-up 0.6s ease-out both" }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-teal to-teal/70 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            Robot policies ranked by ELO from head-to-head evaluation
          </p>
        </header>

        {/* Stats summary */}
        <div
          className="grid grid-cols-3 gap-4 mb-10"
          style={{ animation: "fade-up 0.6s ease-out 0.15s both" }}
        >
          {[
            { label: "Policies", value: sortedPolicies.length.toString() },
            { label: "Top ELO", value: maxElo.toString() },
            { label: "Total Matches", value: sortedPolicies.reduce((a, p) => a + p.wins + p.losses, 0).toString() },
          ].map((stat) => (
            <div key={stat.label} className="bg-white rounded-xl border border-warm-200 px-5 py-4">
              <div className="text-xs uppercase tracking-widest text-ink-muted font-medium mb-1">
                {stat.label}
              </div>
              <div className="font-display text-2xl text-ink">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Leaderboard */}
        <div
          className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden"
          style={{ animation: "fade-up 0.6s ease-out 0.3s both" }}
        >
          {/* Table header */}
          <div className="grid grid-cols-[56px_1fr_100px_140px_100px_140px] px-6 py-3.5 border-b border-warm-100 bg-warm-50">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">#</span>
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">Policy</span>
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">ELO</span>
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">Rating</span>
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">W / L</span>
            <span className="text-[11px] uppercase tracking-widest text-ink-muted font-medium">Win Rate</span>
          </div>

          {/* Rows */}
          {sortedPolicies.map((policy, i) => (
            <div
              key={policy.name}
              className={`grid grid-cols-[56px_1fr_100px_140px_100px_140px] items-center px-6 py-4 transition-colors duration-150 hover:bg-warm-50 ${
                i < sortedPolicies.length - 1 ? "border-b border-warm-100" : ""
              }`}
              style={{
                animation: `slide-in-right 0.4s ease-out ${0.35 + i * 0.04}s both`,
              }}
            >
              {/* Rank */}
              <div>
                <RankBadge rank={i + 1} />
              </div>

              {/* Name + Environment */}
              <div className="flex items-center gap-3">
                <span className="font-body font-semibold text-ink text-[15px]">
                  {policy.name}
                </span>
                <EnvironmentTag env={policy.environment} />
              </div>

              {/* ELO number */}
              <div className="font-mono text-sm font-medium text-ink">
                {policy.elo}
              </div>

              {/* ELO bar */}
              <div className="pr-4">
                <div className="w-full h-2 rounded-full bg-warm-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal to-teal/60 transition-all duration-700 ease-out"
                    style={{ width: `${eloBarWidth(policy.elo)}%` }}
                  />
                </div>
              </div>

              {/* W / L */}
              <div className="font-mono text-sm text-ink-muted">
                <span className="text-emerald-bar">{policy.wins}</span>
                <span className="text-warm-300 mx-1">/</span>
                <span className="text-rose-bar">{policy.losses}</span>
              </div>

              {/* Win Rate */}
              <WinRateBar wins={policy.wins} losses={policy.losses} />
            </div>
          ))}
        </div>

        {/* Footer */}
        <footer
          className="mt-8 text-center text-xs text-ink-muted/60"
          style={{ animation: "fade-up 0.6s ease-out 0.8s both" }}
        >
          ELO ratings computed from pairwise policy evaluations
        </footer>
      </div>
    </div>
  );
}

export default App;
