import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SessionDetail({ sessionId }: { sessionId: Id<"evalSessions"> }) {
  const detail = useQuery(api.evalSessions.getDetail, { id: sessionId });

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

      {/* Rounds grid */}
      <div className="space-y-2">
        {detail.rounds.map((round) => (
          <div
            key={round.index}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-warm-50/50"
          >
            <span className="text-xs font-mono text-ink-muted w-16 shrink-0">
              Round {round.index}
            </span>
            <div className="flex gap-2 flex-wrap">
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
          </div>
        ))}
      </div>
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
