import pilot from "./data/stage-reference-pilot.json";
import { useSearchParamNumber } from "../src/lib/useSearchParam";
import type { ReviewSample } from "./stageReviewSamples";
import { pilotReview, pilotReviewStatus, type PilotEpisode, type PilotSave } from "./pilotReviewStatus";

const taskNames = {marker_d2: "Marker", square_d2: "Square nut", routing_d1: "Routing"};
export default function PilotQueue({current, saves, taxonomy, onSelect, onBrowse}: {
  current: ReviewSample;
  saves: PilotSave[];
  taxonomy: string;
  onSelect: (row: PilotEpisode) => void;
  onBrowse: () => void;
}) {
  const [episode] = useSearchParamNumber("episode");
  const rows = pilot.episodes.filter((row) => row.task === current.task);
  const done = (row: PilotEpisode) => ["confirmed", "corrected"].includes(pilotReviewStatus(saves, row, taxonomy) ?? "");
  const carried = (row: PilotEpisode) => {
    const save = pilotReview(saves, row, taxonomy);
    return save?.status !== "cleared" && !done(row) && !!save?.local_migration;
  };
  const carriedCount = rows.filter(carried).length;
  const position = rows.findIndex((row) => row.dataset === current.dataset && row.episode === episode);
  return <section aria-label="20-episode reference set" className="px-6 py-4 border-b border-warm-200 bg-warm-50">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Reference task" className="flex gap-2">
        {Object.entries(taskNames).map(([task, name]) => <button key={task} type="button"
          aria-current={task === current.task ? "page" : undefined}
          disabled={task === current.task}
          className={`rounded-lg px-3 py-2 text-sm ${task === current.task ? "bg-teal text-white" : "bg-white border border-warm-200"}`}
          onClick={() => onSelect(pilot.episodes.find((row) => row.task === task)!)}>{name} · 20</button>)}
      </nav>
      <span className="text-sm">{rows.filter(done).length}/20 labeled{carriedCount > 0 && ` · ${carriedCount} carried forward to check`} · <span className="text-teal">7 success</span> · <span className="text-coral">13 failure</span></span>
      <div className="flex gap-3 text-sm">
        <button disabled={position <= 0} onClick={() => onSelect(rows[position - 1])} className="text-teal disabled:opacity-40">← Previous</button>
        <button disabled={position < 0 || position === rows.length - 1} onClick={() => onSelect(rows[position + 1])} className="text-teal disabled:opacity-40">Next →</button>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
      {pilot.sources.filter((source) => source.task === current.task)
        .sort((a, b) => rows.findIndex((row) => row.dataset === a.repo) - rows.findIndex((row) => row.dataset === b.repo)).map((source) =>
        <div key={source.repo} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-muted mr-1">{source.name}</span>
          {rows.filter((row) => row.dataset === source.repo).map((row) => {
            const selected = row.dataset === current.dataset && row.episode === episode;
            const status = pilotReviewStatus(saves, row, taxonomy);
            return <button key={row.episode} type="button" aria-current={selected ? "step" : undefined}
              aria-label={`${source.name} episode ${row.episode}, ${row.outcome}${done(row) ? ", labeled" : carried(row) ? ", stages carried forward, needs check" : status === "draft" ? ", draft" : status === "uncertain" ? ", uncertain" : ""}`}
              onClick={() => onSelect(row)}
              className={`rounded-md border px-2 py-1 text-xs ${row.outcome === "success" ? "bg-teal-light text-teal" : "bg-coral-light text-coral"} ${selected ? "ring-2 ring-ink border-ink" : "border-transparent"}`}>
              {done(row) ? "✓ " : carried(row) ? "↪ " : status === "draft" ? "… " : status === "uncertain" ? "? " : ""}Ep {row.episode}
            </button>;
          })}
        </div>)}
    </div>
    <div className="mt-2 flex justify-between gap-4 text-xs text-ink-muted">
      <span>Mark stages from the video. Model stage suggestions are hidden.</span>
      <button onClick={onBrowse} className="text-teal underline">Browse full datasets</button>
    </div>
  </section>;
}
