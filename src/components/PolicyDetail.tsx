import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import RolloutSection from "./RolloutSection";

function CollapsibleSection({
  title,
  count,
  countColor,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  count: number | undefined;
  countColor: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left cursor-pointer group"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`text-ink-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          <polygon points="8,4 20,12 8,20" />
        </svg>
        <span className="text-sm font-medium text-ink group-hover:text-teal transition-colors">
          {title}
        </span>
        {count !== undefined && (
          <span
            className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${countColor}`}
          >
            {count}
          </span>
        )}
      </button>
      {isOpen && children}
    </div>
  );
}

export default function PolicyDetail({
  policyId,
}: {
  policyId: Id<"policies">;
}) {
  const policy = useQuery(api.policies.get, { id: policyId });
  const sessions = useQuery(api.evalSessions.getByPolicy, {
    policy_id: policyId,
  });
  const eloHistory = useQuery(api.eloHistory.getByPolicy, {
    policy_id: policyId,
  });
  const recentResults = useQuery(api.roundResults.getRecentByPolicy, {
    policy_id: policyId,
  });
  const failureResults = useQuery(api.roundResults.getFailuresByPolicy, {
    policy_id: policyId,
  });

  const [rolloutsOpen, setRolloutsOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);

  if (!policy) return null;

  return (
    <div className="px-6 py-5 bg-warm-50/30">
      <div className="grid grid-cols-2 gap-6">
        {/* Left: info */}
        <div>
          <h3 className="text-sm font-medium text-ink mb-3">Details</h3>
          <dl className="space-y-2 text-xs">
            <div className="flex gap-2">
              <dt className="text-ink-muted w-24 shrink-0">W&B Artifact</dt>
              <dd className="font-mono text-ink break-all">
                <a
                  href={(() => {
                    const [entity, project, rest] = [
                      ...policy.wandb_artifact.split("/").slice(0, 2),
                      policy.wandb_artifact.split("/").slice(2).join("/"),
                    ];
                    const [name, version] = rest.split(":");
                    return `https://wandb.ai/${entity}/${project}/artifacts/policy/${name}/${version}`;
                  })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal hover:underline"
                >
                  {policy.wandb_artifact}
                </a>
              </dd>
            </div>
            {policy.wandb_run_url && (
              <div className="flex gap-2">
                <dt className="text-ink-muted w-24 shrink-0">W&B Run</dt>
                <dd>
                  <a
                    href={policy.wandb_run_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal hover:underline font-mono"
                  >
                    View run &rarr;
                  </a>
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="text-ink-muted w-24 shrink-0">Draws</dt>
              <dd className="font-mono text-ink">{Number(policy.draws)}</dd>
            </div>
          </dl>

          {/* ELO History */}
          {eloHistory && eloHistory.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-ink mb-2">ELO History</h3>
              <div className="flex items-end gap-1 h-12">
                {eloHistory.map((entry, i) => {
                  const min = Math.min(...eloHistory.map((e) => e.elo));
                  const max = Math.max(...eloHistory.map((e) => e.elo));
                  const range = max - min || 1;
                  const height = 20 + ((entry.elo - min) / range) * 80;
                  return (
                    <div
                      key={i}
                      className="flex-1 bg-teal/30 rounded-t hover:bg-teal/50 transition-colors"
                      style={{ height: `${height}%` }}
                      title={`ELO: ${Math.round(entry.elo)}`}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: recent sessions */}
        <div>
          <h3 className="text-sm font-medium text-ink mb-3">
            Recent Sessions
          </h3>
          {sessions === undefined ? (
            <div className="text-xs text-ink-muted">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="text-xs text-ink-muted">No sessions yet</div>
          ) : (
            <div className="space-y-2">
              {sessions.slice(0, 5).map((session) => (
                <a
                  key={session._id}
                  href={`?tab=sessions&session=${session._id}`}
                  className="block px-3 py-2 rounded-lg bg-white border border-warm-200 text-xs hover:border-teal/40 hover:shadow-sm transition-all"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-ink-muted">
                      {new Date(session._creationTime).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-2">
                      <SessionModeTag mode={session.session_mode ?? "manual"} />
                      <span className="text-ink-muted font-mono">
                        {Number(session.num_rounds)} rounds
                      </span>
                    </div>
                  </div>
                  <span className="text-teal font-mono text-[11px]">
                    {session.dataset_repo}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rollout sections */}
      <div className="mt-5 pt-5 border-t border-warm-200 space-y-3">
        <CollapsibleSection
          title="Recent Rollouts"
          count={recentResults?.length}
          countColor="bg-teal-light text-teal"
          isOpen={rolloutsOpen}
          onToggle={() => setRolloutsOpen((o) => !o)}
        >
          <RolloutSection
            results={recentResults ?? []}
            isOpen={rolloutsOpen}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Failures"
          count={failureResults?.length}
          countColor="bg-coral-light text-coral"
          isOpen={failuresOpen}
          onToggle={() => setFailuresOpen((o) => !o)}
        >
          <RolloutSection
            results={failureResults ?? []}
            isOpen={failuresOpen}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
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
