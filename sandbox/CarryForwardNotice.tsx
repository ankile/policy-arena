import { useState } from "react";
import { planCarryForward } from "./carryForwardReviews";
import type { LocalReview } from "./localReviewStore";

export default function CarryForwardNotice({ reviews, current, onTransfer }: {
  reviews: LocalReview[];
  current: LocalReview | undefined;
  onTransfer: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = planCarryForward(reviews);
  const issues = current?.status === "draft" || current?.status === "uncertain" ? current.local_migration?.issues ?? [] : [];
  if (!plan.additions.length && !plan.blocked.length && !issues.length && !error) return null;
  return <div className="px-6 py-3 border-b border-warm-200 text-sm" aria-label="Carry forward local annotations">
    {plan.additions.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3">
      <span>Keep your existing stage marks and timestamps. Originals stay backed up; ambiguous changes need review.</span>
      <button disabled={busy} className="text-teal underline" onClick={async () => {
        setBusy(true); setError(null);
        try { await onTransfer(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Transfer failed; originals are preserved."); }
        finally { setBusy(false); }
      }}>Carry forward {plan.additions.length} saved reviews</button>
    </div>}
    {issues.length > 0 && <p role="status">Stage marks carried forward. {issues.join(" ")} Confirm when checked.</p>}
    {plan.blocked.length > 0 && <p role="alert">{plan.blocked.length} older reviews could not be transferred safely; originals remain in the export.</p>}
    {error && <p role="alert" className="text-coral">{error}</p>}
  </div>;
}
