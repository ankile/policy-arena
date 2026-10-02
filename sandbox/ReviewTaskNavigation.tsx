import { reviewSamples, type ReviewSample } from "./stageReviewSamples";

const tasks = reviewSamples.filter((sample, index) =>
  reviewSamples.findIndex((other) => other.task === sample.task) === index);

export default function ReviewTaskNavigation({ current, onSelect }: {
  current: ReviewSample;
  onSelect: (sample: ReviewSample) => void;
}) {
  const datasets = reviewSamples.filter((sample) => sample.task === current.task);
  return <div className="flex flex-col gap-3">
    <nav className="flex flex-wrap gap-2" aria-label="Task">
      {tasks.map((sample) => <button key={sample.task} type="button"
        aria-current={sample.task === current.task ? "page" : undefined}
        disabled={sample.task === current.task}
        className={`px-3 py-2 rounded-lg border text-sm ${sample.task === current.task ? "bg-teal text-white" : "bg-white border-warm-200"}`}
        onClick={() => onSelect(sample)}>{sample.taskName}</button>)}
    </nav>
    {datasets.length > 1 && <div className="flex flex-col gap-1">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span>Dataset</span>
        <select className="rounded-lg border border-warm-200 bg-white px-3 py-2"
          value={current.dataset} onChange={(event) => {
            const sample = datasets.find((item) => item.dataset === event.target.value);
            if (sample && sample.dataset !== current.dataset) onSelect(sample);
          }}>
          {datasets.map((sample) => <option key={sample.dataset} value={sample.dataset}>{sample.datasetName}</option>)}
        </select>
      </label>
    </div>}
  </div>;
}
