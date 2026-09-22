import { useState } from "react";
import type { StageLabelFormProps } from "./StageLabelForm";
import { TimeControls } from "./ReviewTimeControls";
import { patchStageMark, relinkStagePredecessors, stageContext, stageTitle } from "../../lib/stageTimeline";

const button = "rounded-lg border border-warm-200 px-3 py-2 text-sm text-teal cursor-pointer disabled:opacity-40";
const input = "w-full rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm";

/** Human-facing projection: only stage judgments are editable or attested. */
export function TrajectoryStageEditor(props: StageLabelFormProps) {
  const { spec, row } = props;
  const task = spec.trajectory!.task_definition;
  const [choice, setChoice] = useState<string | null>(null);
  const [attemptOverride, setAttemptOverride] = useState<number | undefined>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ before: typeof row; after: string; attempt?: number } | null>(null);
  let context: ReturnType<typeof stageContext> | null = null;
  try { context = stageContext(spec.trajectory!, row, (props.frame + 0.5) / spec.fps, attemptOverride); }
  catch { /* A malformed stage list is retained and shown below, not replaced. */ }
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
    if (!stage || !context || props.disabled) return;
    try {
      const index = existing?.index ?? null;
      const next = patchStageMark(spec.trajectory!, row, index, stage.id, time, attempt);
      remember(next, `transition:${index ?? context.marks.length}`, `${existing ? "Updated" : "Marked"} S${stage.index}${time === null ? " · time not set" : ` at ${time.toFixed(2)} s`}.`);
    } catch (cause) { setError((cause as Error).message); }
  };
  const markNow = () => {
    if (props.markDisabled) return false;
    const frame = props.markFrame();
    if (frame === null) return false;
    mark(frame / spec.fps); return true;
  };
  const selectStage = (id: string) => { setChoice(id); props.onSelectEvent?.(null); };

  return <section className="space-y-5" aria-label="Stage labeling" data-testid="trajectory-form">
    <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-medium">Label stages</h3>
      <span className="rounded-lg bg-warm-100 px-3 py-1 font-mono text-sm">{(props.frame / spec.fps).toFixed(2)} s</span></div>
    <p className="text-sm text-ink-muted">Pause when a stage is reached, then mark this frame. You can skip stages that never happened.</p>
    <div className="border-l-2 border-teal pl-3"><p className="text-xs text-ink-muted">Progress recorded by this frame · attempt {context?.attempt ?? "—"}</p>
      <p className="mt-1 text-base font-medium">{context?.current ? stageTitle(context.current) : "No stage reached yet"}</p></div>
    {context ? <div className="rounded-xl border border-teal/30 bg-teal/5 p-4 space-y-3">
      <label className="block text-sm font-medium">{selected ? "Edit this stage mark" : "Which stage was reached?"}
        <select aria-label="Stage reached" className={`${input} mt-2`} disabled={blocked} value={stage?.id ?? ""} onChange={(e) => {
          if (selected) {
            try { remember(patchStageMark(spec.trajectory!, row, selected.index, e.target.value, selected.time, attempt), props.selectedEventKey ?? null, "Stage label updated."); }
            catch (cause) { setError((cause as Error).message); }
          } else selectStage(e.target.value);
        }}><option value="">Choose a stage…</option>{task.stages.filter((s) => s.index > 0).map((s) => <option key={s.id} value={s.id}>{stageTitle(s)}</option>)}</select>
      </label>
      {stage && <>
        <p className="text-base">{stage.description}</p>
        <details className="text-sm"><summary className="cursor-pointer text-teal">What counts as this stage?</summary>
          <ul className="list-disc pl-5 mt-2 space-y-1">{stage.entryCriteria.map((text) => <li key={text}>{text}</li>)}</ul>
          {stage.exclusions?.map((text) => <p key={text} className="mt-2 text-ink-muted">{text}</p>)}</details>
        {!selected && existing && <button className="text-sm text-teal underline cursor-pointer" disabled={blocked} onClick={() => {
          props.onSelectEvent?.(`transition:${existing.index}`); setChoice(null); if (existing.time !== null) props.onSeekTime(existing.time);
        }}>Watch existing mark · {existing.time?.toFixed(2) ?? "unset"} s</button>}
        {!selected && <button className="w-full rounded-lg bg-teal px-4 py-3 text-base font-medium text-white cursor-pointer disabled:opacity-40"
          disabled={blocked || props.markDisabled || ambiguous} onClick={markNow}>{existing ? `Move S${stage.index} to this frame` : `Mark S${stage.index} here`}</button>}
      </>}
      {ambiguous && <p className="text-sm text-coral">There is more than one matching mark. Select the intended one below the video.</p>}
      {selected && <>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Transition ${selected.index + 1} time`}>
          <TimeControls t={selected.time} fps={spec.fps} frame={props.frame} flagged={props.violations.some((v) => v.fields.includes(`stage_transitions.${selected.index}`))}
            disabled={props.disabled} markDisabled={props.markDisabled} markTitle="Use the paused frame" comfortable preservePrecision
            onPendingInputChange={props.onPendingInputChange} onCommit={mark} onMark={markNow} onSeek={props.onSeekTime}
            canClear={selected.time !== null} onClear={() => mark(null)} clearTitle="Clear stage time" />
        </div>
        <label className="block text-sm">Attempt for this mark<input aria-label={`Transition ${selected.index + 1} attempt`} className={`${input} mt-1`} type="number" min="1" max={Number(row.attempt_count)} value={Number.isFinite(attempt) ? attempt : ""} disabled={blocked} onChange={(e) => {
          const events = context!.marks.map((m) => m.index === selected.index ? { ...m.event, attempt_index: e.target.value === "" ? null : Number(e.target.value) } : m.event);
          remember(relinkStagePredecessors(spec.trajectory!, { ...row, stage_transitions: events }), props.selectedEventKey ?? null, "Updated the stage attempt.");
        }} /></label>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={blocked} onClick={() => { props.onSelectEvent?.(null); setChoice(null); }}>Next stage</button>
          <button className={`${button} text-coral`} disabled={blocked} onClick={() => remember(relinkStagePredecessors(spec.trajectory!, { ...row, stage_transitions: context!.marks.filter((m) => m.index !== selected.index).map((m) => m.event) }), null, "Stage mark removed. Check the furthest stage below.")}>Remove this mark</button></div>
      </>}
    </div> : <p role="alert" className="text-sm text-coral">The stage timeline could not be read. Its original data is preserved; repair the source before labeling.</p>}
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
    {notice && <p role="status" className="text-sm text-teal">{notice}</p>}
    {undo?.after === JSON.stringify(row) && <button className={button} disabled={blocked} onClick={() => {
      props.onEdit(undo.before); props.onSelectEvent?.(null); setAttemptOverride(undo.attempt); setChoice(null); setUndo(null); setNotice("Last stage edit undone.");
    }}>Undo stage edit</button>}
    <div className="border-t border-warm-200 pt-4 space-y-3">
      <label className="block text-sm font-medium">Furthest stage reached in the episode<select className={`${input} mt-2`} aria-label="Furthest stage" disabled={blocked}
        value={task.stages.find((s) => s.id === row.max_stage_id && s.index === row.max_stage)?.id ?? ""}
        onChange={(e) => { const s = task.stages.find((s) => s.id === e.target.value)!; remember({ ...row, max_stage: s.index, max_stage_id: s.id }, props.selectedEventKey ?? null, `Furthest stage set to S${s.index}.`); }}>
        <option value="" disabled>Choose the furthest stage…</option>{task.stages.map((s) => <option key={s.id} value={s.id}>{stageTitle(s)}</option>)}</select></label>
      <p className="text-xs text-ink-muted">A new mark advances this summary if needed. Keep earlier progress even if the episode later fails. S0 needs no timestamp.</p>
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
        <button className={button} disabled={blocked || !context} onClick={() => remember(relinkStagePredecessors(spec.trajectory!, { ...row, stage_transitions: context!.sorted.map((m) => m.event) }), null, "Stage marks ordered by time.")}>Order stage marks by time</button>
      </div></details>
      <label className="block text-sm">Your review notes<textarea aria-label="Your review notes" className={`${input} mt-1`} rows={2} value={props.humanNotes ?? ""} disabled={props.disabled || !props.onHumanNotesChange} onChange={(e) => props.onHumanNotesChange?.(e.target.value)} placeholder="Optional uncertainty or observations" /></label>
    </div>
    {props.violations.length > 0 && <details className="rounded-lg bg-gold-light p-3"><summary className="text-sm cursor-pointer">Stage checklist · {props.violations.length} items</summary>
      {props.violations.map((v, i) => <p key={i} className="text-sm mt-2">{v.message}</p>)}</details>}
    <p className="text-xs text-ink-muted">Confirmation covers stage labels and timestamps only. Other prediction fields are preserved, not reviewed.</p>
  </section>;
}
