import type { StageLabelFormProps } from "./StageLabelForm";
import { stageContext, stageTitle } from "../../lib/stageTimeline";

export function TrajectoryStageRail(props: StageLabelFormProps) {
  let context: ReturnType<typeof stageContext>;
  try { context = stageContext(props.spec.trajectory!, props.row, (props.frame + 0.5) / props.spec.fps); }
  catch { return null; }
  const select = (mark: typeof context.marks[number]) => {
    props.onSelectEvent?.(`transition:${mark.index}`);
    if (mark.time !== null) props.onSeekTime(mark.time);
  };
  const at = props.frame / props.spec.fps;
  const before = context.sorted.filter((m) => m.time !== null && m.time < at - 0.5 / props.spec.fps).at(-1);
  const after = context.sorted.find((m) => m.time !== null && m.time > at + 0.5 / props.spec.fps);
  return <section className="mt-5 space-y-3" aria-label="Stage timeline">
    <div className="flex flex-wrap justify-between items-center gap-2"><h3 className="text-base font-medium">Stages reached</h3>
      <div className="flex gap-3 text-sm text-teal"><button className="cursor-pointer disabled:opacity-30" disabled={props.hasPendingInput || !before} onClick={() => before && select(before)}>← Previous stage</button>
        <button className="cursor-pointer disabled:opacity-30" disabled={props.hasPendingInput || !after} onClick={() => after && select(after)}>Next stage →</button></div></div>
    {context.sorted.length === 0 ? <p className="rounded-lg border border-dashed border-warm-300 p-4 text-sm text-ink-muted">No stage times yet. Pause the video and mark the first stage reached.</p>
      : <ol className="space-y-1 max-h-80 overflow-auto">{context.sorted.map((mark) => <li key={mark.index}>
        <button className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left cursor-pointer disabled:opacity-40 ${props.selectedEventKey === `transition:${mark.index}` ? "bg-teal/10 ring-1 ring-teal" : "bg-white hover:bg-warm-100"}`}
          disabled={props.hasPendingInput} onClick={() => select(mark)} aria-label={`Inspect stage mark ${mark.index + 1}`}>
          <span className="w-16 shrink-0 font-mono text-sm text-teal">{mark.time?.toFixed(2) ?? "Unset"}{mark.time !== null ? " s" : ""}</span>
          <span className="flex-1 text-sm">{mark.stage ? stageTitle(mark.stage) : "Unknown stage"}</span>
          {Number(props.row.attempt_count) > 1 && <span className="text-xs text-ink-muted">Attempt {Number.isSafeInteger(mark.event.attempt_index) ? String(mark.event.attempt_index) : "?"}</span>}
        </button>
      </li>)}</ol>}
    <p className="text-xs text-ink-muted">Click a stage to watch that moment and adjust its time. Only recorded stages are shown.</p>
  </section>;
}
