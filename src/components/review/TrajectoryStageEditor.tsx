import { useState, type ReactNode } from "react";
import type { StageLabelFormProps } from "./StageLabelForm";
import { TimeControls } from "./ReviewTimeControls";
import { patchStageMark, relinkStagePredecessors, removeStageMark, stageContext, stageTitle, StageTimelineDataError } from "../../lib/stageTimeline";
import { policyFrameCount } from "../../../convex/trajectoryTime";
import { useWindowKeydown, isTypingTarget } from "./useWindowKeydown";

const button = "rounded-lg border border-warm-200 px-3 py-2 text-sm text-teal cursor-pointer disabled:opacity-40";
const input = "w-full rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm";
const endStateTitle = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replaceAll("_", " ");
const resultOptions = [
  { value: true, title: "Success", color: "text-emerald-800 accent-emerald-700 focus-within:outline-emerald-700", selected: "border-emerald-700 bg-emerald-100 ring-1 ring-emerald-700 font-semibold", idle: "border-emerald-200 bg-emerald-50" },
  { value: false, title: "Failure", color: "text-red-800 accent-red-700 focus-within:outline-red-700", selected: "border-red-700 bg-red-100 ring-1 ring-red-700 font-semibold", idle: "border-red-200 bg-red-50" },
];

/** Human-facing projection: stages, result, end state and primary failure mode. */
export function TrajectoryStageEditor(props: StageLabelFormProps & { video?: ReactNode; timeline?: ReactNode; episodeDurationS?: number | null }) {
  const { spec, row } = props;
  const task = spec.trajectory!.task_definition;
  const failureMode = task.failureModes.find((item) => item.id === row.failure_mode);
  const noFailure = task.successDefinition.noFailureModeId;
  const policyFrames = policyFrameCount(props.episodeDurationS, spec.fps);
  const finalState = task.finalStates.find((item) => item.id === row.final_state);
  const endStates = row.task_success === true
    ? task.finalStates.filter((item) => task.successDefinition.successfulFinalStateIds.includes(item.id))
    : task.finalStates;
  const incompatibleEnd = !!finalState && !endStates.some((item) => item.id === finalState.id);
  const outcomeIssues = props.violations.filter((issue) => issue.fields.some((field) => ["task_success", "final_state", "failure_mode"].includes(field)));
  const [choice, setChoice] = useState<string | null>(null);
  const [attemptOverride, setAttemptOverride] = useState<number | undefined>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ before: typeof row; after: string; attempt?: number } | null>(null);
  let context: ReturnType<typeof stageContext> | null = null;
  try { context = stageContext(spec.trajectory!, row, (props.frame + 0.5) / spec.fps, attemptOverride); }
  catch (cause) { if (!(cause instanceof StageTimelineDataError)) throw cause; }
  const selected = context?.marks.find((mark) => `transition:${mark.index}` === props.selectedEventKey);
  const stage = task.stages.find((s) => s.id === (choice ?? selected?.stage?.id ?? context?.next?.id));
  const attempt = selected ? Number(selected.event.attempt_index) : context?.attempt ?? 1;
  const matches = context?.marks.filter((m) => m.stage?.id === stage?.id && m.event.attempt_index === attempt) ?? [];
  const existing = selected ?? (matches.length === 1 ? matches[0] : undefined);
  const ambiguous = !selected && matches.length > 1;
  const blocked = props.disabled || props.hasPendingInput;
  const remember = (next: typeof row, selectedKey: string | null, message: string) => {
    if (JSON.stringify(next) === JSON.stringify(row)) return;
    setUndo({ before: row, after: JSON.stringify(next), attempt: attemptOverride });
    props.onEdit(next); props.onSelectEvent?.(selectedKey); setChoice(null); setError(null); setNotice(message);
  };
  const mark = (time: number | null) => {
    if (!stage || !context || props.disabled || (!selected && existing)) return;
    try {
      const index = existing?.index ?? null;
      const next = patchStageMark(spec.trajectory!, row, index, stage.id, time, attempt);
      remember(next, index === null ? null : `transition:${index}`, `${existing ? "Updated" : "Marked"} S${stage.index}${time === null ? " · time not set" : ` at ${time.toFixed(2)} s`}.`);
    } catch (cause) { setError((cause as Error).message); }
  };
  const markNow = () => {
    if (props.markDisabled || props.disabled || (!selected && existing)) return false;
    const frame = props.markFrame();
    if (frame === null) return false;
    mark(frame / spec.fps); return true;
  };
  const selectStage = (id: string) => { setChoice(id); props.onSelectEvent?.(null); };
  useWindowKeydown((event) => {
    if (event.key.toLowerCase() !== "m" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event) || blocked) return;
    event.preventDefault(); markNow();
  });
  const inspectExisting = () => {
    if (!existing) return;
    props.onSelectEvent?.(`transition:${existing.index}`); setChoice(null);
    if (existing.time !== null) props.onSeekTime(existing.time);
  };

  return <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]" aria-label="Stage labeling" data-testid="trajectory-form">
    <div className="min-w-0" data-testid="video-labeling-workspace">
    {props.video}
    <div className="mt-2 rounded-xl border border-teal/30 bg-teal/5 p-3 space-y-3" role="region" aria-label="Stage marking controls">
    {context ? <>
      <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 basis-64 text-sm font-medium">{selected ? "Edit stage mark" : "Stage reached"}
        <select aria-label="Stage reached" className={`${input} mt-1`} disabled={blocked} value={stage?.id ?? ""} onChange={(e) => {
          if (selected) {
            try { remember(patchStageMark(spec.trajectory!, row, selected.index, e.target.value, selected.time, attempt), props.selectedEventKey ?? null, "Stage label updated."); }
            catch (cause) { setError((cause as Error).message); }
          } else selectStage(e.target.value);
        }}><option value="">Choose a stage…</option>{task.stages.filter((s) => s.index > 0).map((s) => <option key={s.id} value={s.id}>{stageTitle(s)}</option>)}</select>
      </label>
      {!selected && <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm">{(props.frame / spec.fps).toFixed(2)} s</span>
        <button className="rounded-lg bg-teal px-4 py-2.5 text-sm font-medium text-white cursor-pointer disabled:opacity-40"
          disabled={!stage || blocked || (!existing && props.markDisabled) || ambiguous} onClick={existing ? inspectExisting : markNow}>{stage ? existing ? `Inspect S${stage.index} mark` : `Mark S${stage.index} here` : "All stages marked"}</button>
        {!existing && stage && <span className="text-sm text-ink-muted">M</span>}
      </div>}
      {selected && <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Transition ${selected.index + 1} time`}>
          <TimeControls t={selected.time} fps={spec.fps} frame={props.frame} flagged={props.violations.some((v) => v.fields.includes(`stage_transitions.${selected.index}`))}
            disabled={props.disabled} markDisabled={props.markDisabled} markTitle="Use the paused frame" comfortable preservePrecision
            onPendingInputChange={props.onPendingInputChange} onCommit={mark} onMark={markNow} onSeek={props.onSeekTime}
            canClear={selected.time !== null} onClear={() => mark(null)} clearTitle="Clear stage time" />
      </div>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <p className="flex-1 text-ink-muted">{context.current ? `At playhead: ${stageTitle(context.current)}` : "Pause → choose stage → mark (M)"}</p>
        {selected && <>
          <button className={button} disabled={blocked} onClick={() => { props.onSelectEvent?.(null); setChoice(null); }}>Next stage</button>
          <button className="text-coral cursor-pointer disabled:opacity-40" disabled={blocked} onClick={() => remember(removeStageMark(spec.trajectory!, row, selected.index), null, "Stage mark removed; furthest stage updated.")}>Remove this mark</button>
        </>}
      </div>
      {ambiguous && <p className="text-sm text-coral">There is more than one matching mark. Select the intended one in the timeline.</p>}
      {props.violations.some((issue) => issue.message.includes("Order stage marks by time")) && <button className={button} disabled={blocked} onClick={() => remember({ ...row, stage_transitions: context!.sorted.map((mark) => mark.event) }, null, "Stage marks ordered by time.")}>Order stage marks by time</button>}
      {stage && <details className="text-sm"><summary className="cursor-pointer text-teal">What counts as this stage?</summary>
        <p className="mt-2 text-base">{stage.description}</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">{stage.entryCriteria.map((text) => <li key={text}>{text}</li>)}</ul>
        {stage.exclusions?.map((text) => <p key={text} className="mt-2 text-ink-muted">{text}</p>)}</details>}
    </> : <p role="alert" className="text-sm text-coral">The stage timeline could not be read. Its original data is preserved; repair the source before labeling.</p>}
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
    {(notice || undo?.after === JSON.stringify(row)) && <div className="flex flex-wrap items-center gap-3">
      {notice && <p role="status" className="text-sm text-teal">{notice}</p>}
      {undo?.after === JSON.stringify(row) && <button className={button} disabled={blocked} onClick={() => {
        props.onEdit(undo.before); props.onSelectEvent?.(null); setAttemptOverride(undo.attempt); setChoice(null); setUndo(null); setNotice("Last label edit undone.");
      }}>Undo last edit</button>}
    </div>}
    </div>
    {props.timeline}
    </div>
    <aside className="min-w-0 rounded-xl border border-warm-200 bg-warm-50 p-4 space-y-4" aria-label="Episode review settings">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-medium">Episode review</h3>
      {policyFrames !== null && <button className="text-sm text-teal underline cursor-pointer disabled:opacity-40"
        disabled={blocked} onClick={() => props.onSeekTime((policyFrames - 1) / spec.fps)}>Watch ending</button>}
    </div>
    <div className="space-y-3">
      <fieldset disabled={blocked} className="space-y-2">
        <legend className="text-sm font-medium mb-2">Did the task succeed?</legend>
        <div className="grid grid-cols-2 gap-2">{resultOptions.map(({ value, title, color, selected, idle }) => <label key={String(value)} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 ${color} ${row.task_success === value ? selected : idle} ${blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
          <input type="radio" name="episode-result" checked={row.task_success === value} onChange={() => remember({ ...row, task_success: value,
            failure_mode: value ? noFailure : row.failure_mode === noFailure ? "" : row.failure_mode }, props.selectedEventKey ?? null, `Result set to ${value ? "success" : "failure"}.`)} />
          {title}
        </label>)}</div>
        <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer"><input type="radio" name="episode-result" checked={typeof row.task_success !== "boolean"}
          onChange={() => remember({ ...row, task_success: null, failure_mode: "" }, props.selectedEventKey ?? null, "Result left undecided. Save as uncertain if needed.")} />Not sure yet</label>
      </fieldset>
      <details className="text-sm"><summary className="cursor-pointer text-teal">What counts as success?</summary>
        <ul className="list-disc pl-5 mt-2 space-y-1">{task.successCriteria.map((text) => <li key={text}>{text}</li>)}</ul>
      </details>
      {row.task_success !== true && <>
        <label className="block text-sm font-medium">Why did it fail?
          <select aria-label="Primary failure mode" aria-describedby={row.task_success === false && failureMode?.id !== noFailure && failureMode ? "primary-failure-description" : undefined} className={`${input} mt-2`} disabled={blocked || row.task_success !== false}
            value={row.task_success === false && failureMode?.id !== noFailure ? failureMode?.id ?? "" : ""}
            onChange={(event) => remember({ ...row, failure_mode: event.target.value }, props.selectedEventKey ?? null, "Primary failure mode updated.")}>
            <option value="">Choose the main reason…</option>{task.failureModes.filter((item) => item.id !== noFailure).map((item) => <option key={item.id} value={item.id}>{endStateTitle(item.id)}</option>)}
          </select>
        </label>
        {row.task_success === false && failureMode && failureMode.id !== noFailure && <details className="text-sm">
          <summary className="cursor-pointer text-teal">Failure mode definition</summary>
          <p id="primary-failure-description" className="mt-2 text-ink-muted">{failureMode.description}</p>
        </details>}
      </>}
      <label className="block text-sm font-medium">How did the episode end?
        <select className={`${input} mt-2`} aria-label="End state" aria-describedby={[finalState ? "episode-end-description" : "", row.task_success === true ? "episode-end-options" : ""].filter(Boolean).join(" ") || undefined} aria-invalid={incompatibleEnd || undefined} value={finalState?.id ?? ""} disabled={blocked}
          onChange={(e) => remember({ ...row, final_state: e.target.value }, props.selectedEventKey ?? null, "End state updated.")}>
          <option value="">Choose the end state…</option>
          {incompatibleEnd && <option value={finalState.id} disabled>{endStateTitle(finalState.id)} — not valid for Success</option>}
          {endStates.map((item) => <option key={item.id} value={item.id}>{endStateTitle(item.id)}</option>)}
        </select>
      </label>
      {row.task_success === true && <p id="episode-end-options" className={`text-sm ${incompatibleEnd ? "text-coral" : "text-ink-muted"}`}>{incompatibleEnd
        ? "This end state conflicts with Success. Change the end state or result."
        : "Successful end states only."}</p>}
      {finalState && <details className="text-sm">
        <summary className="cursor-pointer text-teal">End state definition</summary>
        <p id="episode-end-description" className="mt-2 text-ink-muted">{finalState.description}</p>
      </details>}
      {outcomeIssues.length > 0 && <div className="rounded-lg bg-gold-light p-3 text-sm" aria-label="Result checklist">{outcomeIssues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
      <div className="border-t border-warm-200" />
      {selected && <details><summary className="text-sm text-teal cursor-pointer">Attempt for this mark · {Number.isFinite(attempt) ? attempt : "unset"}</summary>
        <label className="block text-sm mt-2">Attempt<input aria-label={`Transition ${selected.index + 1} attempt`} className={`${input} mt-1`} type="number" min="1" max={Number(row.attempt_count)} value={Number.isFinite(attempt) ? attempt : ""} disabled={blocked} onChange={(e) => {
          const events = context!.marks.map((m) => m.index === selected.index ? { ...m.event, attempt_index: e.target.value === "" ? null : Number(e.target.value) } : m.event);
          remember(relinkStagePredecessors(spec.trajectory!, { ...row, stage_transitions: events }, new Set([attempt, Number(e.target.value)])), props.selectedEventKey ?? null, "Updated the stage attempt.");
        }} /></label>
      </details>}
      <label className="block text-sm font-medium">Furthest stage reached in the episode<select className={`${input} mt-2`} aria-label="Furthest stage" disabled={blocked}
        value={task.stages.find((s) => s.id === row.max_stage_id && s.index === row.max_stage)?.id ?? ""}
        onChange={(e) => { const s = task.stages.find((s) => s.id === e.target.value)!; remember({ ...row, max_stage: s.index, max_stage_id: s.id }, props.selectedEventKey ?? null, `Furthest stage set to S${s.index}.`); }}>
        <option value="" disabled>Choose the furthest stage…</option>{task.stages.map((s) => <option key={s.id} value={s.id}>{stageTitle(s)}</option>)}</select></label>
      <p className="text-xs text-ink-muted">Highest marked stage · S0 if none.</p>
      <details><summary className="text-sm text-teal cursor-pointer">Retries and timeline settings</summary><div className="mt-3 space-y-3">
        <label className="block text-sm">Attempt count<input aria-label="Attempt count" type="number" min="1" className={input} value={typeof row.attempt_count === "number" ? row.attempt_count : ""} disabled={blocked} onChange={(e) => {
          remember({ ...row, attempt_count: e.target.value === "" ? null : Number(e.target.value) }, null, "Attempt count updated."); setAttemptOverride(undefined);
        }} /></label>
        <label className="block text-sm">Label attempt<select aria-label="Label attempt" className={input} value={attemptOverride ?? "auto"} disabled={blocked} onChange={(e) => {
          setAttemptOverride(e.target.value === "auto" ? undefined : Number(e.target.value)); props.onSelectEvent?.(null); setChoice(null);
        }}><option value="auto">Follow video position</option>{Array.from({ length: Number.isSafeInteger(row.attempt_count) ? Math.min(1000, Math.max(0, Number(row.attempt_count))) : 0 }, (_, i) => <option key={i + 1} value={i + 1}>Attempt {i + 1}</option>)}</select></label>
        <button className={button} disabled={blocked || !Number.isSafeInteger(row.attempt_count) || Number(row.attempt_count) < 1} onClick={() => {
          const nextAttempt = Number(row.attempt_count) + 1; remember({ ...row, attempt_count: nextAttempt }, null, `Started attempt ${nextAttempt}.`); setAttemptOverride(nextAttempt);
        }}>Start another attempt</button>
      </div></details>
      <label className="block text-sm">Your review notes<textarea aria-label="Your review notes" className={`${input} mt-1`} rows={2} value={props.humanNotes ?? ""} disabled={props.disabled || !props.onHumanNotesChange} onChange={(e) => props.onHumanNotesChange?.(e.target.value)} placeholder="Optional uncertainty or observations" /></label>
    </div>
    {props.violations.length > 0 && <details className="rounded-lg bg-gold-light p-3"><summary className="text-sm cursor-pointer">Review checklist · {props.violations.length} items</summary>
      {props.violations.map((v, i) => <p key={i} className="text-sm mt-2">{v.message}</p>)}</details>}
    </aside>
  </section>;
}
