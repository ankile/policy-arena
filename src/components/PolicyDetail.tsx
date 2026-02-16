import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import FailureAnalysis from "./FailureAnalysis";

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
                {policy.wandb_artifact}
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
                <div
                  key={session._id}
                  className="px-3 py-2 rounded-lg bg-white border border-warm-200 text-xs"
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
                  <a
                    href={`https://huggingface.co/datasets/${session.dataset_repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal hover:underline font-mono text-[11px]"
                  >
                    {session.dataset_repo}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Failure Analysis */}
      <div className="mt-5 pt-5 border-t border-warm-200">
        <FailureAnalysis policyId={policyId} />
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
