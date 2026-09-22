import type { StageLabelFormProps } from "./StageLabelForm";
import { progressAtTime } from "../../lib/trajectoryProgress";
import { readableEventName, type VideoEvent } from "../../lib/trajectoryVideoEvents";

/** Navigation only. Missing rungs are not inferred or written into the label. */
export function TrajectoryEventRail(props: StageLabelFormProps) {
  const tag = props.spec.trajectory!;
  let progress: ReturnType<typeof progressAtTime>;
  try { progress = progressAtTime(tag, props.row, (props.frame + 0.5) / props.spec.fps); }
  catch { return <p className="mt-4 text-sm text-ink-muted">Resolve the episode structure in All fields to show its progress.</p>; }
  const { events } = progress;
  const select = (event: VideoEvent) => {
    props.onSelectEvent?.(event.key);
    if (event.time !== null) props.onSeekTime(event.time);
  };
  const at = props.frame / props.spec.fps;
  const before = events.filter((e) => e.time !== null && e.time < at - 0.5 / props.spec.fps).at(-1);
  const after = events.find((e) => e.time !== null && e.time > at + 0.5 / props.spec.fps);
  const symbols = { stage: "●", action: "◆", failure: "▲" };
  const eventButton = (event: VideoEvent) => <button key={event.key} disabled={props.hasPendingInput}
    className={`flex items-start gap-3 w-full text-left rounded-lg px-3 py-2 text-sm cursor-pointer ${props.selectedEventKey === event.key ? "bg-teal/10 ring-1 ring-teal" : "hover:bg-warm-100"}`}
    aria-label={`${event.title} at ${event.time?.toFixed(2) ?? "unset"} seconds, attempt ${event.attempt ?? "unset"}`} onClick={() => select(event)}>
    <span className="w-16 shrink-0 font-mono text-xs pt-0.5 text-teal">{event.time?.toFixed(2) ?? "Unset"}{event.time !== null ? " s" : ""}</span>
    <span className="flex-1">{symbols[event.kind]} {event.title}</span><span className="text-xs text-ink-muted">#{event.attempt ?? "?"}</span>
  </button>;
  const nearby = events.filter((e) => e.time !== null && Math.abs(e.time - at) <= 0.5 / props.spec.fps);
  return <section className="mt-5 space-y-3" aria-label="Episode timeline">
    <div className="flex flex-wrap justify-between items-center gap-2">
      <h3 className="text-sm font-medium">Recorded milestones · attempt {progress.attempt}</h3>
      <div className="flex gap-3 text-sm text-teal">
        <button className="disabled:opacity-30 cursor-pointer" disabled={props.hasPendingInput || !before} onClick={() => before && select(before)}>← Previous mark</button>
        <button className="disabled:opacity-30 cursor-pointer" disabled={props.hasPendingInput || !after} onClick={() => after && select(after)}>Next mark →</button>
      </div>
    </div>
    <div className="flex gap-1 overflow-x-auto pb-1" aria-label="Stage progress">
      {tag.task_definition.stages.map((stage) => {
        const mark = events.find((event) => event.kind === "stage" && event.definitionId === stage.id && event.attempt === progress.attempt);
        const reached = mark?.time !== null && mark?.time !== undefined && mark.time <= (props.frame + 0.5) / props.spec.fps;
        return <button key={stage.id} disabled={!mark || props.hasPendingInput} onClick={() => mark && select(mark)}
          title={`${stage.name === `S${stage.index}` ? readableEventName(stage.id) : stage.name} · ${mark ? "Click to inspect" : "No stage mark"}`}
          aria-label={`Inspect S${stage.index} · ${mark?.time?.toFixed(2) ?? "not timed"} seconds`}
          className={`min-w-14 flex-1 rounded-lg border px-2 py-2 text-center ${progress.current?.id === stage.id ? "border-teal bg-teal text-white" : reached ? "border-teal/25 bg-teal/5 text-teal" : "border-warm-200 text-ink-muted"} ${mark ? "cursor-pointer" : "opacity-50 border-dashed"}`}>
          <span className="block text-sm font-medium">S{stage.index}</span><span className="block text-xs mt-1">{mark ? mark.time?.toFixed(2) ?? "Unset" : "—"}</span>
        </button>;
      })}
    </div>
    {nearby.length > 0 && <div className="rounded-lg border border-warm-200 bg-white" aria-label="Marks at this frame">{nearby.map(eventButton)}</div>}
    <details className="rounded-xl border border-warm-200 bg-white p-3">
      <summary className="cursor-pointer text-sm text-teal">All {events.length} marks · stages, actions & failures</summary>
      <div className="mt-2 max-h-72 overflow-auto" aria-label="All event marks">{events.map(eventButton)}</div>
      {events.length === 0 && <p className="mt-2 text-sm text-ink-muted">No marks yet. Position the video and mark the next milestone.</p>}
    </details>
  </section>;
}
