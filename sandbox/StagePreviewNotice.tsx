import { useSearchParam } from "../src/lib/useSearchParam";
import { latestStagePreviews, stagePreviewHref, type PreviewTask } from "./localStagePreviews";

export default function StagePreviewNotice({ task }: { task: PreviewTask }) {
  const [schema] = useSearchParam("schema", "");
  const candidate = latestStagePreviews[task];
  const definition = candidate.trajectory.task_definition;
  return <aside className="rounded-xl border border-teal/30 bg-teal/5 p-4 mb-4 text-sm" aria-label="Task definition version">
    {schema === candidate.taxonomy_version ? <>
      <p className="font-medium">{definition.displayName} · {definition.taxonomyVersion} · local preview</p>
      <p className="mt-1">{definition.stages.filter((stage) => stage.index > 0).map((stage) => `S${stage.index} ${stage.name}`).join(" → ")}</p>
      <p className="mt-1">{task === "routing_d1"
        ? "Release does not prove seating or success."
        : "Mark achieved milestones, not attempted ones. A failure ending at S3 means lift achieved; S4 insertion alignment was not reached. The failure cause and physical end state remain separate."}</p>
      <p className="mt-1 text-ink-muted">Earlier predictions and reviews keep their original definitions. This version starts without model prefill. No migration or Gemini rerun.</p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Failure causes and end states · definition reference</summary>
        <p className="mt-2">Stages say what was achieved. Failure causes explain the unresolved problem. End states describe the final physical scene; they do not determine the cause.</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {[{ title: "Failure causes", items: definition.failureModes }, { title: "Physical end states", items: definition.finalStates }].map(({ title, items }) => (
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
    </> : <>
      <p>You are viewing an earlier task definition. Existing predictions and reviews keep that version.</p>
      <a className="inline-block mt-1 text-teal underline" href={stagePreviewHref(task, window.location.search)}>Try {definition.displayName} ({definition.taxonomyVersion})</a>
    </>}
  </aside>;
}
