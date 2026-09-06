import type { StageLabelRow } from "../../../convex/stageConsistency";
import { TrajectoryActionEditor } from "./TrajectoryActionEditor";
import { TimeControls } from "./ReviewTimeControls";
import type { StageLabelFormProps } from "./StageLabelForm";
import { trajectoryReviewMessage } from "../../lib/trajectoryReviewMessages";

const inputClass = "rounded-lg border border-warm-200 bg-white px-2 py-2 text-sm text-ink min-w-0 max-w-full";
const buttonClass = "rounded-lg border border-warm-200 px-2 py-1.5 text-xs text-teal hover:bg-warm-50 cursor-pointer disabled:opacity-40";
const confidences = ["low", "medium", "high"];
function record(value: unknown): value is StageLabelRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function records(value: unknown): value is StageLabelRow[] {
  return Array.isArray(value) && value.every(record);
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The trajectory contract has repeated occurrences and independent summary
 * decisions. Explicit action edits synchronize redundant occurrence summaries. */
export function TrajectoryLabelForm(props: StageLabelFormProps) {
  const { spec, row, onEdit, disabled, blind = false, violations } = props;
  const structureDisabled = disabled || props.hasPendingInput;
  if (!spec.trajectory) throw new Error("Trajectory form requires a trajectory spec");
  const task = spec.trajectory.task_definition;
  const readable = (id: string) => id.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  const options = (items: Array<{ id: string; name?: string; description: string }>) => items.map((item) => ({ value: item.id, text: item.name || readable(item.id), title: item.description }));
  const stageName = (stage: typeof task.stages[number]) => stage.name === `S${stage.index}` ? readable(stage.id) : stage.name;
  const stages = task.stages.map((stage) => ({ value: stage.id, text: `S${stage.index}: ${stageName(stage)}`, title: stage.description }));
  const selectedStage = task.stages.find((stage) => stage.id === row.max_stage_id && stage.index === row.max_stage);
  const select = (name: string, value: unknown, choices: Array<{ value: string; text: string; title?: string }>, change: (value: string) => void) => {
    const valid = typeof value === "string" && choices.some((choice) => choice.value === value);
    return <select aria-label={name} className={inputClass} disabled={disabled} value={valid ? value : "__invalid__"}
      onChange={(event) => change(event.target.value)}>
      {!valid && <option value="__invalid__" disabled>{blind ? "Unset or invalid value" : `Unset or invalid: ${String(value ?? "")}`}</option>}
      {choices.map((choice) => <option key={choice.value} value={choice.value} title={choice.title}>{choice.text}</option>)}
    </select>;
  };
  const confidence = (name: string, value: unknown, change: (value: string) => void) => select(name, value, confidences.map((value) => ({ value, text: value })), change);
  const boolean = (name: string, value: unknown, change: (value: boolean) => void) => select(name,
    typeof value === "boolean" ? String(value) : value,
    [{ value: "true", text: "Yes" }, { value: "false", text: "No" }], (value) => change(value === "true"));
  const integer = (name: string, value: unknown, change: (value: number | null) => void) => <input
    aria-label={name} className={`${inputClass} w-16`} type="number" step="1" min="1" disabled={disabled}
    value={number(value) ?? ""} onChange={(event) => change(event.target.value === "" ? null : Number(event.target.value))} />;
  const time = (name: string, value: unknown, change: (value: number | null) => void) => <div className="flex flex-wrap items-center gap-1" role="group" aria-label={name}>
    <span className="text-xs text-ink-muted">{name.replace(/^Action \d+ first time$/, "First time")}</span>
    <TimeControls comfortable onPendingInputChange={props.onPendingInputChange} preservePrecision t={number(value)} fps={spec.fps} frame={props.frame} flagged={false} disabled={disabled}
      markDisabled={props.markDisabled} markTitle={`set ${name} from displayed frame`} onCommit={change}
      onMark={() => { const frame = props.markFrame(); if (frame === null) return false; change(frame / spec.fps); return true; }}
      onSeek={props.onSeekTime} canClear={value !== null} onClear={() => change(null)} clearTitle={`Clear ${name}`} />
  </div>;
  const text = (name: string, value: unknown, change: (value: string) => void) => blind ? null : <label className="block text-xs text-ink-muted">{name}
    <textarea aria-label={name} disabled={disabled} className={`${inputClass} block w-full`} rows={2}
      value={typeof value === "string" ? value : ""} onChange={(event) => change(event.target.value)} />
  </label>;
  const newOccurrence = () => ({ attempt_index: 1, time_s: null, confidence: "medium", evidence: "" });
  const occurrence = (event: StageLabelRow, name: string, edit: (patch: StageLabelRow) => void) => <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-ink-muted">Attempt</span>
      {integer(`${name} attempt`, event.attempt_index, (attempt_index) => edit({ attempt_index }))}
      {confidence(`${name} confidence`, event.confidence, (confidence) => edit({ confidence }))}
    </div>
    {time(`${name} time`, event.time_s, (time_s) => edit({ time_s }))}
    {text(`${name} evidence`, event.evidence, (evidence) => edit({ evidence }))}
  </div>;
  const reorder = (items: StageLabelRow[], index: number, delta: number, change: (items: StageLabelRow[]) => void) => {
    const result = [...items]; [result[index], result[index + delta]] = [result[index + delta], result[index]]; change(result);
  };
  const controls = (name: string, items: StageLabelRow[], index: number, change: (items: StageLabelRow[]) => void) => <div className="flex gap-2">
    <button className={buttonClass} disabled={structureDisabled || index === 0} aria-label={`Move ${name} earlier`} onClick={() => reorder(items, index, -1, change)}>↑</button>
    <button className={buttonClass} disabled={structureDisabled || index === items.length - 1} aria-label={`Move ${name} later`} onClick={() => reorder(items, index, 1, change)}>↓</button>
    <button className={buttonClass} disabled={structureDisabled} aria-label={`Remove ${name}`} onClick={() => change(items.filter((_, i) => i !== index))}>Remove</button>
  </div>;
  const invalidArray = (name: string, reset: () => void) => <div className="space-y-2"><p role="alert" className="text-xs text-coral">{name} has an invalid structure. Its value is preserved until you explicitly clear it; inspect the immutable source after unblinding.</p><button className={buttonClass} disabled={structureDisabled} onClick={reset}>Clear invalid {name.toLowerCase()}</button></div>;
  const transitions = row.stage_transitions;
  const actions = row.key_action_observations;
  const failures = row.failure_events;
  const stageEdit = (id: string, prefix: "from" | "to") => {
    const stage = task.stages.find((stage) => stage.id === id);
    if (!stage) throw new Error("Selected stage is absent from the task definition");
    return { [`${prefix}_stage_id`]: stage.id, [`${prefix}_stage_index`]: stage.index };
  };

  return <div className="space-y-5" data-testid="trajectory-form">
    <div>
      <h3 className="text-base font-medium text-ink">Episode label</h3>
      <p className="mt-1 text-xs text-ink-muted">Check the prediction against the video. Review the summary and event history before confirming.</p>
    </div>
    {violations.length > 0 && <div role="alert" className="rounded-lg border border-coral/30 bg-coral-light p-3 space-y-1">
      <p className="text-sm font-medium text-coral">Resolve before confirming</p>
      {violations.map((violation, index) => <p key={index} className="text-xs text-coral">{trajectoryReviewMessage(violation, spec, blind)}</p>)}
    </div>}
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Furthest stage reached</legend>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Maximum stage">
        {task.stages.map((stage) => <button key={stage.id} disabled={disabled} aria-pressed={selectedStage?.id === stage.id}
          aria-label={`S${stage.index}: ${stageName(stage)}`} title={stage.description}
          onClick={() => onEdit({ max_stage: stage.index, max_stage_id: stage.id })}
          className={`rounded-lg px-3 py-2 text-sm font-mono cursor-pointer border ${selectedStage?.id === stage.id ? "bg-teal border-teal text-white" : "border-warm-200 text-ink-muted hover:border-teal"} disabled:opacity-40`}>S{stage.index}</button>)}
      </div>
      {selectedStage ? <p className="mt-2 text-sm text-ink-muted"><strong className="text-ink">{stageName(selectedStage)}.</strong> {selectedStage.description}</p>
        : <p role="alert" className="mt-2 text-sm text-coral">Choose a valid maximum stage.</p>}
      <p className="mt-1 text-xs text-ink-muted">Keep earlier progress even if the episode ends in failure.</p>
    </fieldset>
    <details className="text-xs"><summary className="cursor-pointer text-teal">Task definition and decision rules</summary>
      <p className="mt-2">{task.objective}</p>
      <p className="mt-2">Success requires a stage in {task.successDefinition.successfulStageIds.join(", ")};
        final state in {task.successDefinition.successfulFinalStateIds.join(", ")};
        actions {task.successDefinition.requiredKeyActionIds.join(", ") || "(none required)"};
        primary failure {task.successDefinition.noFailureModeId}.</p>
      {task.stages.map((stage) => <p key={stage.id} className="mt-2"><strong>S{stage.index}: {stage.name}</strong> — {stage.description}<br />{stage.entryCriteria.join(" ")}{stage.exclusions?.length ? ` Exclusions: ${stage.exclusions.join(" ")}` : ""}</p>)}
      {task.decisionRules.map((rule) => <p key={rule.id} className="mt-2">{rule.rule}</p>)}
    </details>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="text-xs flex flex-col gap-1">Task success{boolean("Task success", row.task_success, (task_success) => onEdit({ task_success }))}</label>
      <label className="text-xs flex flex-col gap-1">Final state{select("Final state", row.final_state, options(task.finalStates), (final_state) => onEdit({ final_state }))}</label>
      <label className="text-xs flex flex-col gap-1">Primary failure{select("Primary failure", row.failure_mode, options(task.failureModes), (failure_mode) => onEdit({ failure_mode }))}</label>
      <label className="text-xs flex flex-col gap-1">Attempt count{integer("Attempt count", row.attempt_count, (attempt_count) => onEdit({ attempt_count }))}</label>
      <label className="text-xs flex flex-col gap-1">Confidence{confidence("Overall confidence", row.confidence, (confidence) => onEdit({ confidence }))}</label>
    </div>
    {time("Primary failure time", row.primary_failure_time_s, (primary_failure_time_s) => onEdit({ primary_failure_time_s }))}
    <details className="rounded-lg border border-warm-200 p-3 space-y-3">
      <summary className="cursor-pointer text-sm font-medium">Stage transitions ({Array.isArray(transitions) ? transitions.length : "invalid"})</summary>
      {records(transitions) ? <>{transitions.map((event, index) => {
        const name = `Transition ${index + 1}`;
        const change = (items: StageLabelRow[]) => onEdit({ stage_transitions: items });
        const edit = (patch: StageLabelRow) => change(transitions.map((item, i) => i === index ? { ...item, ...patch } : item));
        return <div key={index} className="border-t border-warm-200 pt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs">{name}</span>
            {select(`${name} from stage`, event.from_stage_id, stages, (id) => edit(stageEdit(id, "from")))}<span>→</span>
            {select(`${name} to stage`, event.to_stage_id, stages, (id) => edit(stageEdit(id, "to")))}
          </div>{occurrence(event, name, edit)}{controls(name, transitions, index, change)}
        </div>;
      })}<button className={buttonClass} disabled={structureDisabled} onClick={() => onEdit({ stage_transitions: [...transitions,
        { ...newOccurrence(), ...stageEdit(task.stages[0].id, "from"), ...stageEdit(task.stages[0].id, "to") }] })}>Add transition</button></> : invalidArray("Stage transitions", () => onEdit({ stage_transitions: [] }))}
    </details>
    <section className="space-y-3" aria-label="Key actions">
      <h4 className="text-sm font-medium">Key actions</h4>
      <p className="text-xs text-ink-muted">Each action has one time per occurrence. Choosing No removes its events; the first time is calculated automatically.</p>
      {records(actions) ? actions.map((action, index) => <TrajectoryActionEditor key={index} {...props} action={action} index={index}
        definition={task.keyActions.find((item) => item.id === action.action_id)}
        onChange={(next) => onEdit({ key_action_observations: actions.map((item, i) => i === index ? next : item) })} />)
        : <p role="alert" className="text-xs text-coral">Key actions have an invalid structure. Inspect the original source before replacing them.</p>}
    </section>
    <details className="rounded-lg border border-warm-200 p-3 space-y-3">
      <summary className="cursor-pointer text-sm font-medium">Failure events ({Array.isArray(failures) ? failures.length : "invalid"})</summary>
      {records(failures) ? <>{failures.map((event, index) => {
        const name = `Failure ${index + 1}`;
        const change = (items: StageLabelRow[]) => onEdit({ failure_events: items });
        const edit = (patch: StageLabelRow) => change(failures.map((item, i) => i === index ? { ...item, ...patch } : item));
        return <div key={index} className="border-t border-warm-200 pt-2 space-y-2">
          {select(`${name} mode`, event.failure_mode_id, options(task.failureModes.filter((item) => item.id !== task.successDefinition.noFailureModeId)), (failure_mode_id) => edit({ failure_mode_id }))}
          {occurrence(event, name, edit)}
          <div className="flex gap-2">{controls(name, failures, index, change)}
            <button className={buttonClass} disabled={disabled} onClick={() => onEdit({ failure_mode: event.failure_mode_id, primary_failure_time_s: event.time_s })}>Use failure {index + 1} as primary</button>
          </div>
        </div>;
      })}<button className={buttonClass} disabled={structureDisabled} onClick={() => onEdit({ failure_events: [...failures,
        { ...newOccurrence(), failure_mode_id: task.failureModes.find((item) => item.id !== task.successDefinition.noFailureModeId)?.id ?? "" }] })}>Add failure event</button></> : invalidArray("Failure events", () => onEdit({ failure_events: [] }))}
    </details>
    <label className="text-xs flex gap-2 items-center">Needs further human review{boolean("Needs further human review", row.needs_human_review, (needs_human_review) => onEdit({ needs_human_review }))}</label>
    {blind ? <p className="text-xs text-ink-muted">Free-text evidence, review reasons, and notes are hidden while blind. Their stored content is preserved.</p> : <>
      {Array.isArray(row.review_reasons) && row.review_reasons.every((item) => typeof item === "string") ? <div className="space-y-2">
        <p className="text-xs">Review reasons</p>{row.review_reasons.map((reason, index) => <div key={index} className="flex gap-2">
          <input aria-label={`Review reason ${index + 1}`} className={`${inputClass} flex-1`} disabled={disabled} value={reason}
            onChange={(event) => onEdit({ review_reasons: (row.review_reasons as string[]).map((item, i) => i === index ? event.target.value : item) })} />
          <button className={buttonClass} disabled={disabled} onClick={() => onEdit({ review_reasons: (row.review_reasons as string[]).filter((_, i) => i !== index) })}>Remove reason {index + 1}</button>
        </div>)}<button className={buttonClass} disabled={disabled} onClick={() => onEdit({ review_reasons: [...row.review_reasons as string[], ""] })}>Add review reason</button>
      </div> : invalidArray("Review reasons", () => onEdit({ review_reasons: [] }))}
      {text("Review notes", row.notes, (notes) => onEdit({ notes }))}

    </>}
  </div>;
}
