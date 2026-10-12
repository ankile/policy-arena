import { latestStagePreviews, type PreviewTask } from "./localStagePreviews";

export default function StagePreviewNotice({ task }: { task: PreviewTask }) {
  const candidate = latestStagePreviews[task];
  const definition = candidate.trajectory.task_definition;
  return <aside className="mb-3 text-sm" aria-label="Task definition version">
    <details>
        <summary className="cursor-pointer text-teal">Task guide</summary>
        <p className="mt-2">{definition.stages.filter((stage) => stage.index > 0).map((stage) => `S${stage.index} ${stage.name}`).join(" → ")}</p>
        <p className="mt-2">{task === "routing_d1"
          ? "Success requires both clips to stay seated, not just release."
          : "Correct full seating is success, even while held. Release is optional."}</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {[{ title: "Observable failures", items: definition.failureModes }].map(({ title, items }) => (
            <section key={title} aria-label={title}>
              <h3 className="font-medium">{title}</h3>
              <dl className="mt-2 space-y-3">
                {items.map((item) => <div key={item.id}>
                  <dt className="font-medium">{item.id.replaceAll("_", " ")}</dt>
                  <dd className="text-ink-muted">{item.description}</dd>
                </div>)}
              </dl>
            </section>
          ))}
        </div>
      </details>
  </aside>;
}
