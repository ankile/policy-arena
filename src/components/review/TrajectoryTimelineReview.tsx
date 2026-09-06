import { useState } from "react";
import { analyzeTrajectoryTimeline, repairTrajectoryTimeline, type TrajectoryTimelineRepair } from "../../../convex/trajectoryTimeline";
import type { StageLabelRow } from "../../../convex/stageConsistency";
import type { StageLabelFormProps } from "./StageLabelForm";

const buttonClass = "rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs text-teal hover:bg-warm-50 cursor-pointer disabled:opacity-40";

/** Explicit video-assisted reconciliation; browsing never changes a label. */
export function TrajectoryTimelineReview(props: StageLabelFormProps & {
  /** Restore the exact prior row without re-applying automatic event linking. */
  onRestoreLabel: (row: StageLabelRow) => void;
}) {
  const [undo, setUndo] = useState<{ before: StageLabelRow; after: string } | null>(null);
  if (!props.spec.trajectory) return null;
  const tag = props.spec.trajectory;
  const issues = analyzeTrajectoryTimeline(tag, props.row);
  const canUndo = undo !== null && undo.after === JSON.stringify(props.row);
  if (!issues.length && !canUndo) return null;
  const disabled = props.disabled || props.hasPendingInput;
  const malformed = props.violations.some((violation) => violation.code === "trajectory_shape");
  const repair = (id: string, choice: TrajectoryTimelineRepair) => {
    const next = repairTrajectoryTimeline(tag, props.row, id, choice);
    setUndo({ before: props.row, after: JSON.stringify(next) });
    props.onEdit(next);
  };
  return <section aria-label="Linked event times" className="rounded-lg border border-coral/30 bg-coral-light/30 p-3 space-y-3">
    {issues.length > 0 && <>
      <h4 className="text-sm font-medium text-coral">Review linked event times before confirming</h4>
      <p className="text-xs text-ink-muted">Watch both times, then correct the observation that is wrong. The same event should have one time; a required action may occur earlier than a distinct stage or failure.</p>
    </>}
    {issues.map((issue) => <div key={issue.id} className="border-t border-coral/20 pt-3 space-y-2" role="group" aria-label={issue.message}>
      <p className="text-sm">{issue.message}</p>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={props.disabled} onClick={() => props.onSeekTime(issue.prerequisite.timeS)}>Watch action at {issue.prerequisite.timeS.toFixed(2)} s</button>
        <button className={buttonClass} disabled={props.disabled} onClick={() => props.onSeekTime(issue.dependent.timeS)}>Watch {issue.dependent.kind} at {issue.dependent.timeS.toFixed(2)} s</button>
      </div>
      {issue.repairs.length > 0 && <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={disabled || malformed} onClick={() => repair(issue.id, "use_action_time")}>Set {issue.dependent.kind} to {issue.prerequisite.timeS.toFixed(2)} s</button>
        <button className={buttonClass} disabled={disabled || malformed} onClick={() => repair(issue.id, "use_event_time")}>Set action to {issue.dependent.timeS.toFixed(2)} s</button>
      </div>}
      {malformed && <p className="text-xs text-coral">Repair the invalid field structure before linking event times.</p>}
      <p className="text-xs text-ink-muted">For distinct events or another time, edit the action or event below.</p>
    </div>)}
    {canUndo && <button className={buttonClass} disabled={disabled} onClick={() => { props.onRestoreLabel(undo!.before); setUndo(null); }}>Undo last timeline repair</button>}
  </section>;
}
