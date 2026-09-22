import { useState } from "react";
import type { StageLabelFormProps } from "./StageLabelForm";
import { captureVideoEvent, readableEventName, type VideoEvent, type VideoEventKind } from "../../lib/trajectoryVideoEvents";
import { getUnifiedEventCandidates } from "../../lib/trajectoryUnifiedEvents";
import { moveProgressEvent, progressAtTime, sharedGroupForEvent } from "../../lib/trajectoryProgress";

const button = "rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm text-teal hover:bg-teal/5 disabled:opacity-40 cursor-pointer";
const input = "w-full rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm";
const stageName = (stage: { name: string; index: number; id: string }) => stage.name === `S${stage.index}` ? readableEventName(stage.id) : stage.name;

export function TrajectoryVideoTools(props: StageLabelFormProps & { duration: number; sourceKey: string }) {
  const { spec, row, duration } = props;
  const tag = spec.trajectory!;
  const task = tag.task_definition;
  const [attemptOverride, setAttemptOverride] = useState("");
  const [capture, setCapture] = useState<{ kind: VideoEventKind; time: number; source: string } | null>(null);
  const [id, setId] = useState("");
  const [attempt, setAttempt] = useState("1");
  const [fromStage, setFromStage] = useState(task.stages[0].id);
  const [updateMaximum, setUpdateMaximum] = useState(false);
  const [advanceSummary, setAdvanceSummary] = useState(true);
  const [primaryFailure, setPrimaryFailure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<{ row: typeof row; links: NonNullable<typeof props.eventLinks>; after: string; attempt: string } | null>(null);
  let progress: ReturnType<typeof progressAtTime> | null = null;
  let progressError: string | null = null;
  // Include fractional timestamps at their nearest frame landing, without
  // quantizing source values or consulting the episode's endpoint maximum.
  const time = (props.frame + 0.5) / spec.fps;
  try { progress = progressAtTime(tag, row, time, attemptOverride ? Number(attemptOverride) : undefined); }
  catch (cause) { progressError = (cause as Error).message; }
  const disabled = props.disabled || props.hasPendingInput || progress === null;
  const markDisabled = disabled || props.markDisabled;
  const activeCapture = capture?.source === props.sourceKey ? capture : null;
  const remember = (next: typeof row, key: string | null, message: string) => {
    const groups = getUnifiedEventCandidates(tag, next);
    const links = (props.eventLinks ?? []).filter((link) => groups.some((g) => g.actionId === link.action_id && g.stageId === link.stage_id && g.attemptIndex === link.attempt_index));
    setUndo({ row, links: props.eventLinks ?? [], after: JSON.stringify([next, links]), attempt: attemptOverride });
    props.onEdit(next); props.onEventLinksChange?.(links); props.onSelectEvent?.(key);
    setNotice(message); setError(null); setCapture(null);
  };
  const snap = () => {
    const frame = props.markFrame();
    if (frame === null) return null;
    if (frame / spec.fps > duration) { setError("Seek inside the policy episode, before reset footage."); return null; }
    return frame / spec.fps;
  };
  const guidedMark = (kind: "stage" | "action", definitionId: string, existing: VideoEvent | null) => {
    if (markDisabled || !progress) return;
    const at = snap(); if (at === null) return;
    try {
      const now = progressAtTime(tag, row, at + 0.5 / spec.fps, progress.attempt);
      const result = existing ? { row: moveProgressEvent(tag, row, existing, at, duration, props.eventLinks ?? []), key: existing.key }
        : captureVideoEvent(tag, row, { kind, id: definitionId, time: at, attempt: now.attempt, fromStageId: now.baseline.id }, duration);
      const stage = kind === "stage" ? task.stages.find((s) => s.id === definitionId) : null;
      const currentMax = task.stages.find((s) => s.id === row.max_stage_id && s.index === row.max_stage);
      const next = stage && advanceSummary && (!currentMax || stage.index > currentMax.index)
        ? { ...result.row, max_stage: stage.index, max_stage_id: stage.id } : result.row;
      remember(next, result.key, `${existing ? "Moved" : "Marked"} ${stage ? `S${stage.index}` : task.keyActions.find((a) => a.id === definitionId)?.name} at ${at.toFixed(2)} s.`);
    } catch (cause) { setError((cause as Error).message); }
  };
  const begin = (kind: VideoEventKind) => {
    if (markDisabled || !progress) return;
    const at = snap(); if (at === null) return;
    const current = progressAtTime(tag, row, at, progress.attempt);
    setAttempt(String(current.attempt)); setFromStage(current.baseline.id);
    setId(""); setUpdateMaximum(false); setPrimaryFailure(false); setError(null);
    setCapture({ kind, time: at, source: props.sourceKey });
  };
  const choices = !activeCapture ? [] : activeCapture.kind === "stage"
    ? task.stages.map((s) => ({ id: s.id, name: `S${s.index} · ${stageName(s)}`, description: s.description }))
    : activeCapture.kind === "action" ? task.keyActions
      : task.failureModes.filter((f) => f.id !== task.successDefinition.noFailureModeId).map((f) => ({ ...f, name: readableEventName(f.id) }));
  const choice = choices.find((c) => c.id === id);
  const commit = () => {
    if (!activeCapture || disabled) return;
    try {
      const result = captureVideoEvent(tag, row, { kind: activeCapture.kind, id, time: activeCapture.time, attempt: Number(attempt), fromStageId: fromStage, updateMaximum, primaryFailure }, duration);
      remember(result.row, result.key, `Added ${choice?.name} at ${activeCapture.time.toFixed(2)} s.`);
    } catch (cause) { setError((cause as Error).message); }
  };
  const inspect = (event: VideoEvent) => {
    props.onSelectEvent?.(event.key);
    if (event.time !== null) props.onSeekTime(event.time);
  };
  const shared = (event: VideoEvent | null) => event && sharedGroupForEvent(tag, row, event, props.eventLinks ?? []);

  return <section className="space-y-4 pb-5" aria-label="Label the video">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-lg font-medium">What happens here?</h3>
      <span className="rounded bg-warm-100 px-2 py-1 font-mono text-sm">{(props.frame / spec.fps).toFixed(2)} s</span>
    </div>
    {progressError && <p role="alert" className="text-sm text-coral">{progressError}</p>}
    {progress && <>
      <div className="border-l-2 border-warm-300 pl-3">
        <p className="text-xs text-ink-muted">Recorded progress by this frame · attempt {progress.attempt}</p>
        <p className="text-base font-medium mt-1">{progress.current ? `S${progress.current.index} · ${stageName(progress.current)}` : "No stage marked yet"}</p>
      </div>
      {progress.next ? <div className="rounded-xl border border-teal/30 bg-teal/5 p-4 space-y-3" aria-label="Next milestone">
        <p className="text-xs font-medium uppercase tracking-wide text-teal">{progress.nextEvent ? "Next recorded milestone" : "Suggested next milestone"}</p>
        <h4 className="text-lg font-medium">S{progress.next.index} · {stageName(progress.next)}</h4>
        <p className="text-sm text-ink-muted">{progress.next.description}</p>
        {progress.nextEvent && <button className="text-sm text-teal underline cursor-pointer" disabled={props.hasPendingInput} onClick={() => inspect(progress.nextEvent!)}>
          {progress.nextEvent.time === null ? "Inspect mark with missing time" : `Watch existing mark · ${progress.nextEvent.time.toFixed(2)} s`}
        </button>}
        {shared(progress.nextEvent) && <p className="text-xs text-ink-muted">This stage shares an event with its action; both times will move together.</p>}
        <button className="w-full rounded-lg bg-teal px-4 py-3 text-base font-medium text-white hover:bg-teal/90 disabled:opacity-40 cursor-pointer"
          disabled={markDisabled || progress.nextAmbiguous} onClick={() => guidedMark("stage", progress!.next!.id, progress!.nextEvent)}>
          {progress.nextEvent ? `Move S${progress.next.index} to this frame` : `Mark S${progress.next.index} here`}
        </button>
        {progress.nextAmbiguous && <p className="text-sm text-ink-muted">Several marks match this stage. Pick the intended one from the timeline.</p>}
        <label className="flex items-center gap-2 text-xs text-ink-muted"><input type="checkbox" checked={advanceSummary} onChange={(e) => setAdvanceSummary(e.target.checked)} />Advance the episode’s furthest stage if needed</label>
      </div> : <p className="rounded-lg bg-teal/5 p-3 text-sm">The final stage is already recorded. Check the endpoint in Episode summary, or use Other label to record an exception.</p>}
      {progress.actions.length > 0 && <div className="space-y-2" aria-label="Nearby actions">
        <p className="text-sm font-medium">Actions around this milestone</p>
        {progress.actions.slice(0, 3).map(({ definition, existing, ambiguous }) => <div key={definition.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warm-200 px-3 py-2">
          <div className="flex-1 min-w-36"><p className="text-sm">{definition.name}</p>
            <p className="text-xs text-ink-muted">{ambiguous ? "Several occurrences — select one below the video" : existing ? `Recorded at ${existing.time?.toFixed(2) ?? "unset"} s` : "Not marked in this attempt"}{shared(existing) ? " · shared stage time" : ""}</p>
          </div>
          <button className={button} title={definition.description} disabled={markDisabled || ambiguous} aria-label={`${existing ? "Move" : "Mark"} ${definition.name} here`} onClick={() => guidedMark("action", definition.id, existing)}>{existing ? "Move here" : "Mark here"}</button>
        </div>)}
      </div>}
      <p className="text-xs text-ink-muted">Suggestions follow the recorded stages and task definitions, not live video analysis. Skips, alternate paths, and retries are still allowed.</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <button className={`${button} text-coral`} disabled={markDisabled} onClick={() => begin("failure")}>Something went wrong</button>
      <details className="flex-1 min-w-44 rounded-lg border border-warm-200 p-2.5">
        <summary className="cursor-pointer text-sm text-teal">Other label / retry</summary>
        <div className="space-y-3 pt-3">
          <p className="text-sm text-ink-muted">Use for a skipped stage, a repeat action, or an alternate path. No intermediate events will be invented.</p>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={markDisabled} onClick={() => begin("stage")}>Choose any stage</button>
            <button className={button} disabled={markDisabled} onClick={() => begin("action")}>Choose any action</button>
          </div>
          <label className="block text-sm">Work on attempt<input className={input} type="number" min="1" max={Number(row.attempt_count)} placeholder={`Auto · ${progress?.attempt ?? 1}`} value={attemptOverride} disabled={props.disabled || props.hasPendingInput} onChange={(e) => setAttemptOverride(e.target.value)} /></label>
          <button className={button} disabled={disabled} onClick={() => {
            const nextAttempt = Number(row.attempt_count) + 1;
            remember({ ...row, attempt_count: nextAttempt }, null, `Attempt ${nextAttempt} started. Mark its first event from the video.`);
            setAttemptOverride(String(nextAttempt));
          }}>Start another attempt</button>
        </div>
      </details>
    </div>
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
    {activeCapture && <div className="rounded-xl border border-teal bg-white p-4 space-y-3" role="group" aria-label="Captured moment" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setCapture(null); }}>
      <div className="flex justify-between gap-2"><strong className="text-sm">Captured at {activeCapture.time.toFixed(2)} s</strong><button className="text-sm text-ink-muted" onClick={() => setCapture(null)}>Cancel</button></div>
      <label className="block text-sm">{activeCapture.kind === "stage" ? "Stage reached" : activeCapture.kind === "action" ? "Action" : "Failure mode"}
        <select autoFocus className={input} value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose a label…</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      {choice && <p className="text-sm text-ink-muted">{choice.description}</p>}
      <div className="flex gap-3 items-end">
        <label className="text-sm">Attempt<input className={`${input} max-w-24`} type="number" min="1" max={Number(row.attempt_count)} value={attempt} onChange={(e) => setAttempt(e.target.value)} /></label>
        {activeCapture.kind === "stage" && <label className="flex-1 text-sm">Previous stage<select className={input} value={fromStage} onChange={(e) => setFromStage(e.target.value)}>{task.stages.map((s) => <option key={s.id} value={s.id}>S{s.index} · {stageName(s)}</option>)}</select></label>}
      </div>
      {activeCapture.kind === "stage" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={updateMaximum} onChange={(e) => setUpdateMaximum(e.target.checked)} />Set the episode’s furthest stage to this stage</label>}
      {activeCapture.kind === "failure" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={primaryFailure} onChange={(e) => setPrimaryFailure(e.target.checked)} />Use as the episode’s primary failure</label>}
      <p className="text-xs text-ink-muted">Adds a new observation. To correct an existing mark, select it below the video.</p>
      <button className={button} disabled={!id || !attempt || disabled} onClick={commit}>Mark at {activeCapture.time.toFixed(2)} s</button>
    </div>}
    {notice && <p role="status" className="text-sm text-teal">{notice}</p>}
    {undo?.after === JSON.stringify([row, props.eventLinks ?? []]) && <button className={button} disabled={props.disabled || props.hasPendingInput} onClick={() => {
      props.onEdit(undo.row); props.onEventLinksChange?.(undo.links); props.onSelectEvent?.(null); setAttemptOverride(undo.attempt); setUndo(null); setNotice("Last change undone.");
    }}>Undo last mark</button>}
  </section>;
}
