import { useState } from "react";
import type { StageLabelFormProps } from "./StageLabelForm";
import { captureVideoEvent, eventRecords, projectVideoEvents, readableEventName, type VideoEventKind } from "../../lib/trajectoryVideoEvents";
import { getUnifiedEventCandidates } from "../../lib/trajectoryUnifiedEvents";

const button = "rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm text-teal hover:bg-teal/5 disabled:opacity-40 cursor-pointer";
const input = "w-full rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm";
const laneNames = { stage: "Stage achievements", action: "Key actions", failure: "Failures" };
const symbols = { stage: "●", action: "◆", failure: "▲" };
const colors = { stage: "text-teal", action: "text-indigo-700", failure: "text-coral" };

export function TrajectoryVideoTools(props: StageLabelFormProps & { duration: number; sourceKey: string }) {
  const { spec, row, duration } = props;
  const tag = spec.trajectory!;
  const task = tag.task_definition;
  const [capture, setCapture] = useState<{ kind: VideoEventKind; time: number; source: string } | null>(null);
  const [id, setId] = useState("");
  const [attempt, setAttempt] = useState("1");
  const [fromStage, setFromStage] = useState(task.stages[0].id);
  const [updateMaximum, setUpdateMaximum] = useState(false);
  const [primaryFailure, setPrimaryFailure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ row: typeof row; links: NonNullable<typeof props.eventLinks>; after: string } | null>(null);
  let events: ReturnType<typeof projectVideoEvents> = [];
  let malformed = false;
  try { events = projectVideoEvents(tag, row); } catch { malformed = true; }
  const disabled = props.disabled || props.hasPendingInput || malformed;
  const activeCapture = capture?.source === props.sourceKey ? capture : null;
  const selected = events.find((event) => event.key === props.selectedEventKey);
  const selectEvent = (key: string, time: number | null) => {
    if (props.hasPendingInput) return;
    props.onSelectEvent?.(key);
    if (time !== null) props.onSeekTime(time);
  };
  const begin = (kind: VideoEventKind) => {
    const frame = props.markFrame();
    if (frame === null) return;
    const time = frame / spec.fps;
    if (time > duration) { setError("This frame is in the reset footage. Seek inside the policy episode before marking."); return; }
    const attemptIndex = selected?.attempt ?? (Number(row.attempt_count) === 1 ? 1 : null);
    setAttempt(attemptIndex === null ? "" : String(attemptIndex));
    const previous = eventRecords(row.stage_transitions).filter((e) => e.attempt_index === attemptIndex && typeof e.time_s === "number" && e.time_s <= time)
      .sort((a, b) => Number(b.time_s) - Number(a.time_s))[0];
    setFromStage(typeof previous?.to_stage_id === "string" ? previous.to_stage_id : task.stages[0].id);
    setId(""); setUpdateMaximum(false); setPrimaryFailure(false); setError(null);
    setCapture({ kind, time, source: props.sourceKey });
  };
  const choices = !activeCapture ? [] : activeCapture.kind === "stage"
    ? task.stages.map((s) => ({ id: s.id, name: `S${s.index} · ${s.name === `S${s.index}` ? readableEventName(s.id) : s.name}`, description: s.description }))
    : activeCapture.kind === "action" ? task.keyActions
      : task.failureModes.filter((f) => f.id !== task.successDefinition.noFailureModeId).map((f) => ({ ...f, name: readableEventName(f.id) }));
  const choice = choices.find((c) => c.id === id);
  const commit = () => {
    if (!activeCapture || disabled) return;
    try {
      const result = captureVideoEvent(tag, row, { kind: activeCapture.kind, id, time: activeCapture.time, attempt: Number(attempt), fromStageId: fromStage, updateMaximum, primaryFailure }, duration);
      const groups = getUnifiedEventCandidates(tag, result.row);
      const links = (props.eventLinks ?? []).filter((l) => groups.some((g) => g.actionId === l.action_id && g.stageId === l.stage_id && g.attemptIndex === l.attempt_index));
      setUndo({ row, links: props.eventLinks ?? [], after: JSON.stringify([result.row, links]) });
      props.onEdit(result.row); props.onEventLinksChange?.(links); props.onSelectEvent?.(result.key);
      setCapture(null); setError(null);
    } catch (cause) { setError((cause as Error).message); }
  };
  return <section className="mt-4 space-y-3" aria-label="Label the video">
    <div className="rounded-xl border border-teal/25 bg-teal/5 p-3 space-y-2">
      <p className="text-sm font-medium">Label this moment</p>
      <p className="text-xs text-ink-muted">Play or seek, then capture the displayed frame. Stage marks record when progress was achieved.</p>
      <div className="flex flex-wrap gap-2">
        {(["stage", "action", "failure"] as const).map((kind) => <button key={kind} className={button} disabled={disabled || props.markDisabled} onClick={() => begin(kind)}>
          {symbols[kind]} {kind === "stage" ? "Stage reached" : kind === "action" ? "Action happened" : "Failure observed"}
        </button>)}
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
    {activeCapture && <div className="rounded-xl border border-teal bg-white p-4 space-y-3" role="group" aria-label="Captured moment" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setCapture(null); }}>
      <div className="flex justify-between gap-2"><strong className="text-sm">Captured at {activeCapture.time.toFixed(2)} s</strong><button className="text-sm text-ink-muted" onClick={() => setCapture(null)}>Cancel</button></div>
      <label className="block text-xs">{activeCapture.kind === "stage" ? "Stage reached" : activeCapture.kind === "action" ? "Action" : "Failure mode"}
        <select autoFocus className={input} value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose a label…</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      {choice && <p className="text-sm text-ink-muted">{choice.description}</p>}
      <div className="flex gap-3 items-end">
        <label className="text-xs">Attempt<input className={`${input} max-w-24`} type="number" min="1" max={Number(row.attempt_count)} value={attempt} onChange={(e) => setAttempt(e.target.value)} /></label>
        {activeCapture.kind === "stage" && <label className="flex-1 text-xs">Previous stage<select className={input} value={fromStage} onChange={(e) => setFromStage(e.target.value)}>{task.stages.map((s) => <option key={s.id} value={s.id}>S{s.index} · {s.name === `S${s.index}` ? readableEventName(s.id) : s.name}</option>)}</select></label>}
      </div>
      {activeCapture.kind === "stage" && <label className="flex gap-2 text-xs"><input type="checkbox" checked={updateMaximum} onChange={(e) => setUpdateMaximum(e.target.checked)} />Also set the episode’s furthest stage to this stage</label>}
      {activeCapture.kind === "failure" && <label className="flex gap-2 text-xs"><input type="checkbox" checked={primaryFailure} onChange={(e) => setPrimaryFailure(e.target.checked)} />Use as the episode’s primary failure</label>}
      <p className="text-xs text-ink-muted">Adds one {activeCapture.kind} observation. To correct an existing mark, select it below and use “Move to current frame.”</p>
      <button className={button} disabled={!id || !attempt || disabled} onClick={commit}>Mark at {activeCapture.time.toFixed(2)} s</button>
    </div>}
    {undo?.after === JSON.stringify([row, props.eventLinks ?? []]) && <button className={button} disabled={disabled} onClick={() => { props.onEdit(undo.row); props.onEventLinksChange?.(undo.links); props.onSelectEvent?.(null); setUndo(null); }}>Undo captured event</button>}
    <div className="rounded-xl border border-warm-200 bg-white p-3 space-y-3" aria-label="Event timeline">
      <div className="flex justify-between text-xs text-ink-muted"><span>0 s</span><span>Policy end · {duration.toFixed(2)} s</span></div>
      <div className="overflow-x-auto"><div className="min-w-[28rem] space-y-3">
      {(["stage", "action", "failure"] as const).map((kind) => {
        // Stack near-simultaneous marks instead of covering one with another.
        // The minimum track width keeps a stage chip narrower than this gap.
        const rowEnds: number[] = [];
        const marks = events.filter((event) => event.kind === kind && event.time !== null).map((event) => {
          const position = Math.min(100, Math.max(0, event.time! / duration * 100));
          let laneRow = rowEnds.findIndex((end) => position - end >= 12);
          if (laneRow < 0) laneRow = rowEnds.length;
          rowEnds[laneRow] = position;
          return { event, position, laneRow };
        });
        return <div key={kind}>
        <p className={`text-xs font-medium mb-1 ${colors[kind]}`}>{symbols[kind]} {laneNames[kind]}</p>
        <div className="relative mx-7 min-h-9 rounded bg-warm-50" role="group" aria-label={laneNames[kind]} style={{ height: `${Math.max(1, rowEnds.length) * 2.25}rem` }}>
          <div className="absolute top-0 bottom-0 w-px bg-ink/40 pointer-events-none" style={{ left: `${Math.min(100, Math.max(0, props.frame / spec.fps / duration * 100))}%` }} />
          {marks.map(({ event, position, laneRow }) => <button key={event.key} className={`absolute -translate-x-1/2 rounded px-1.5 py-1 text-sm cursor-pointer ${colors[kind]} ${props.selectedEventKey === event.key ? "bg-warm-200 ring-1 ring-ink" : "bg-white hover:bg-warm-100"}`}
            style={{ left: `${position}%`, top: `${0.125 + laneRow * 2.25}rem` }} disabled={props.hasPendingInput} aria-label={`${event.title} at ${event.time!.toFixed(2)} seconds, attempt ${event.attempt ?? "unset"}`} title={`${event.title} · ${event.time!.toFixed(2)} s · attempt ${event.attempt ?? "unset"}`}
            onClick={() => selectEvent(event.key, event.time)}>{symbols[kind]}{kind === "stage" ? ` ${event.title.split(" · ")[0]}` : ""}</button>)}
        </div>
      </div>; })}
      </div></div>
      {events.length === 0 ? <p className="text-sm text-ink-muted">No marks yet. Capture a stage, action, or failure from the video above.</p> : <>
        <div className="flex gap-2">
          <button className={button} disabled={props.hasPendingInput || !events.some((e) => e.time !== null && e.time < props.frame / spec.fps - 0.5 / spec.fps)} onClick={() => { const e = events.filter((e) => e.time !== null && e.time < props.frame / spec.fps - 0.5 / spec.fps).at(-1); if (e) selectEvent(e.key, e.time); }}>← Previous event</button>
          <button className={button} disabled={props.hasPendingInput || !events.some((e) => e.time !== null && e.time > props.frame / spec.fps + 0.5 / spec.fps)} onClick={() => { const e = events.find((e) => e.time !== null && e.time > props.frame / spec.fps + 0.5 / spec.fps); if (e) selectEvent(e.key, e.time); }}>Next event →</button>
        </div>
        <div className="flex flex-wrap gap-1.5 max-h-28 overflow-auto" aria-label="All event marks">
          {events.map((event) => <button key={event.key} className={`rounded border px-2 py-1 text-xs text-left ${props.selectedEventKey === event.key ? "border-teal bg-teal/10" : "border-warm-200"}`} disabled={props.hasPendingInput} onClick={() => selectEvent(event.key, event.time)}>
            {symbols[event.kind]} {event.time?.toFixed(2) ?? "Time needed"}{event.time !== null ? " s" : ""} · {event.title}
          </button>)}
        </div>
      </>}
      {malformed && <p role="alert" className="text-sm text-coral">An event list is malformed. Inspect the source before editing.</p>}
    </div>
  </section>;
}
