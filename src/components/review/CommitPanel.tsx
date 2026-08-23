import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAge, formatClock } from "./format";

// ---------------------------------------------------------------------------
// Commit panel — apply-job status stream + worker liveness. Extracted VERBATIM
// from OutcomeReview.tsx (Phase-2 component extraction); outcome-review-only
// today (stage gold is pulled repo-side, no apply jobs), but the machinery is
// review-type-agnostic in shape.
// ---------------------------------------------------------------------------

export function CommitPanel({
  repoId,
  numConfirmed,
  numSkipped,
  numEpisodes,
}: {
  repoId: string;
  numConfirmed: number;
  numSkipped: number;
  numEpisodes: number;
}) {
  const jobs = useQuery(api.applyJobs.forRepo, { dataset_repo: repoId });
  const worker = useQuery(api.applyJobs.workerStatus, {});
  const enqueue = useMutation(api.applyJobs.enqueue);
  const cancelJob = useMutation(api.applyJobs.cancel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const activeJob = jobs?.find(
    (job) => job.status === "pending" || job.status === "applying"
  );
  const totalReviews = numConfirmed + numSkipped;

  const age = worker ? now - worker.last_seen : null;
  // Applies run NATIVELY as a scheduled Convex action since 2026-08-21 —
  // there is no polling worker to be "offline". A recent heartbeat means the
  // legacy Python fallback worker (APPLY_NATIVE=0 path) is deliberately
  // running; surface it as information, never as a required dependency.
  const workerPill =
    age !== null && age < 90_000
      ? {
          text: `legacy fallback worker also live ${formatAge(age)}`,
          className: "bg-gold-light text-gold",
        }
      : {
          text: "apply runs natively in Convex",
          className: "bg-teal-light text-teal",
        };

  const statusChip: Record<string, string> = {
    pending: "bg-gold-light text-gold",
    applying: "bg-gold-light text-gold",
    applied: "bg-teal-light text-teal",
    failed: "bg-coral-light text-coral",
    cancelled: "bg-warm-100 text-ink-muted",
  };

  return (
    <div className="border-t border-warm-200 bg-warm-50 px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-ink">
          {numConfirmed} confirmed · {numSkipped} skipped · {numEpisodes} episodes
        </span>
        <span
          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${workerPill.className}`}
          title={worker ? `${worker.worker_id}${worker.info ? ` · ${worker.info}` : ""}` : undefined}
        >
          {workerPill.text}
        </span>
        <div className="flex-1" />
        <button
          disabled={busy || totalReviews === 0 || Boolean(activeJob)}
          onClick={() => {
            setError(null);
            setBusy(true);
            enqueue({ dataset_repo: repoId })
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            busy || totalReviews === 0 || activeJob
              ? "bg-warm-100 text-ink-muted/50 cursor-not-allowed"
              : "bg-teal text-white hover:bg-teal/90 cursor-pointer"
          }`}
        >
          {activeJob ? `Job ${activeJob.status}…` : "Commit to HuggingFace"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-coral/30 bg-coral-light px-3 py-2 text-xs text-coral font-mono">
          {error}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {jobs.map((job) => (
            <div
              key={job._id}
              className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-ink-muted"
            >
              <span
                className={`px-1.5 py-0.5 rounded ${statusChip[job.status] ?? "bg-warm-100 text-ink-muted"}`}
              >
                {job.status}
              </span>
              <span>{formatClock(job.requested_at)}</span>
              <span>{job.requested_by}</span>
              {job.num_confirmed != null && (
                <span>
                  {Number(job.num_confirmed)} confirmed ·{" "}
                  {Number(job.num_skipped ?? BigInt(0))} skipped
                </span>
              )}
              {job.hf_commit_sha && (
                <a
                  href={`https://huggingface.co/datasets/${repoId}/tree/${job.hf_commit_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal hover:underline"
                >
                  {job.hf_commit_sha.slice(0, 8)} →
                </a>
              )}
              {job.error && (
                <button
                  onClick={() => setExpanded(expanded === job._id ? null : job._id)}
                  className="text-coral hover:underline cursor-pointer"
                >
                  {expanded === job._id ? "hide error" : "show error"}
                </button>
              )}
              {(job.status === "pending" ||
                (job.status === "applying" &&
                  job.started_at !== undefined &&
                  now - Number(job.started_at) > 10 * 60 * 1000)) && (
                <button
                  onClick={() => {
                    setError(null);
                    cancelJob({ id: job._id }).catch((err: Error) =>
                      setError(err.message)
                    );
                  }}
                  className="text-ink-muted hover:text-coral cursor-pointer"
                  title={
                    job.status === "applying"
                      ? "Worker claim went stale — reclaim the stuck job, then re-commit"
                      : undefined
                  }
                >
                  {job.status === "applying" ? "reclaim stuck job" : "cancel"}
                </button>
              )}
              {expanded === job._id && (
                <pre className="w-full whitespace-pre-wrap rounded bg-white border border-warm-200 p-2 text-[10px] text-coral">
                  {job.error}
                  {job.log_tail ? `\n\n${job.log_tail}` : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
