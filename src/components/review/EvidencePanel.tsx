import type { ExportedStageSpec } from "../../../convex/stageConsistency";

// ---------------------------------------------------------------------------
// Model-evidence rail for the stage review: the prefill's pipeline identity,
// review-reason flags, confidence, sample-vote summary, and click-to-seek
// telemetry. Collapsed by default (cv2 parity: form an opinion before seeing
// the model's). Policy/arm identity is deliberately NOT rendered here — blind
// redaction happens at the data layer in StageReview, not per widget.
// ---------------------------------------------------------------------------

export interface StagePrefillView {
  label: Record<string, unknown>;
  reviewReason: string | null;
  violationCodes: string[];
  confidence: string | null;
  voteSummary: Record<string, unknown> | null;
  episodeDurationS: number | null;
  pipeline: { name: string; version: string; git_commit: string };
  evidence: Record<string, unknown>;
  pushedAt: number;
}

const CONFIDENCE_CHIP: Record<string, string> = {
  high: "bg-teal-light text-teal",
  medium: "bg-gold-light text-gold",
  low: "bg-coral-light text-coral",
};

export function EvidencePanel({
  spec,
  prefill,
  onSeekTime,
}: {
  spec: ExportedStageSpec;
  prefill: StagePrefillView | null;
  onSeekTime: (timeS: number) => void;
}) {
  if (prefill === null) {
    return (
      <div className="text-xs text-ink-muted font-body px-1">
        No pipeline prediction for this episode under taxonomy{" "}
        {spec.taxonomy_version}.
      </div>
    );
  }
  const reasons = (prefill.reviewReason ?? "")
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean);
  const label = prefill.label;
  const predictedTimes = spec.time_fields
    .map((tf) => [tf, label[tf]] as const)
    .filter(([, v]) => typeof v === "number");

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-warm-100 text-ink"
          title={`git ${prefill.pipeline.git_commit} · pushed ${new Date(prefill.pushedAt).toLocaleString()}`}
        >
          {prefill.pipeline.name}@{prefill.pipeline.version}
        </span>
        {prefill.confidence && (
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
              CONFIDENCE_CHIP[prefill.confidence] ?? "bg-warm-100 text-ink-muted"
            }`}
          >
            {prefill.confidence} confidence
          </span>
        )}
      </div>

      {reasons.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
            Review flags
          </div>
          <div className="flex flex-wrap gap-1">
            {reasons.map((reason) => (
              <span
                key={reason}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                  reason.startsWith("consistency:")
                    ? "bg-coral-light text-coral"
                    : "bg-gold-light text-gold"
                }`}
              >
                {reason}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
          Prediction
        </div>
        <div className="space-y-0.5 font-mono text-[11px] text-ink">
          <p>
            {spec.stage_field}: S{String(label[spec.stage_field] ?? "?")}
          </p>
          <p className="text-ink-muted">{String(label[spec.failure_mode_field] ?? "—")}</p>
          <p className="text-ink-muted">→ {String(label[spec.final_state_field] ?? "—")}</p>
        </div>
      </div>

      {prefill.voteSummary && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
            Sample votes
          </div>
          <div className="space-y-0.5 font-mono text-[11px] text-ink-muted">
            {Object.entries(prefill.voteSummary).map(([key, value]) => (
              <p key={key}>
                {key}: {String(value)}
              </p>
            ))}
          </div>
        </div>
      )}

      {predictedTimes.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
            Predicted event times
          </div>
          <div className="space-y-0.5">
            {predictedTimes.map(([tf, v]) => (
              <button
                key={tf}
                onClick={() => onSeekTime(v as number)}
                className="block w-full text-left font-mono text-[11px] text-teal hover:underline cursor-pointer"
                title={`seek to ${v}s`}
              >
                {tf}: {String(v)}s → f{Math.round((v as number) * spec.fps)}
              </button>
            ))}
          </div>
        </div>
      )}

      {typeof prefill.evidence.run_name === "string" && (
        <p className="text-[10px] font-mono text-ink-muted/70 break-all">
          run {prefill.evidence.run_name}
          {typeof prefill.evidence.model === "string" ? ` · ${prefill.evidence.model}` : ""}
        </p>
      )}
    </div>
  );
}
