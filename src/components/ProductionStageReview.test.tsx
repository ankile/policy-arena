import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { getFunctionName } from "convex/server";
import StageReview from "./StageReview";
import { stageReviewRelease } from "../../shared/stageReviewRelease";
import { stageReviewTasks } from "../../shared/stageReviewTasks";
import { createStageReviewFixture } from "../../tests/browser/stageReviewFixture";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(async () => { await act(async () => cleanup()); });
afterAll(() => GlobalRegistrator.unregister());

function setup(task: typeof stageReviewTasks[number], live: boolean | "missing" = true, outcome = "success", schema = task.previousVersion as string) {
  window.history.replaceState(null, "", `/?tab=explorer&view=stage&dataset=org/repo&episode=0&schema=${schema}&prediction=old-model-run`);
  const fixture = createStageReviewFixture();
  fixture.props.task = task.task;
  fixture.state.outcome = outcome;
  const spec = stageReviewRelease[task.task];
  if (live !== "missing") fixture.state.specRows.unshift({ taxonomy_version: task.version, live, spec });
  fixture.state.fetchSignals = async () => ({ detectedOutcome: outcome, validLength: 120, lastValidFrame: 119, doneOnsetFrame: null, rewardSpikeFrames: [] });
  const query = fixture.props.dataSource.useQuery;
  const queriedVersions: string[] = [];
  fixture.props.dataSource.useQuery = ((ref, args) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (args && typeof args === "object" && "taxonomy_version" in args) queriedVersions.push(String(args.taxonomy_version));
    if (name === "stagePrefills:forRepo") return [];
    if (name === "stagePredictions:listForRepo") return { runs: [], active_run_id: null, legacy_count: 0 };
    return query(ref, args as never);
  }) as typeof query;
  const view = render(<StageReview {...fixture.props} fixedTaxonomyVersion={stageReviewTasks.find((entry) => entry.task === fixture.props.task)!.version} requireLiveTaxonomy />);
  return { ...fixture, view, spec, queriedVersions };
}

for (const task of stageReviewTasks) {
  test(`${task.name}: an old prediction link without a schema cannot seed the latest form`, async () => {
    const { view, state } = setup(task, true, "success", "");
    await act(async () => {});
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("legacy");
    expect(new URLSearchParams(window.location.search).get("schema")).toBe(task.version);
    expect(view.queryByRole("alert")).toBeNull();
    expect(state.saves).toHaveLength(0);
  });
  for (const outcome of ["success", "failure"]) test(`${task.name}: production uses latest stages and existing human ${outcome}, never old predictions`, async () => {
    const { view, state, spec, queriedVersions } = setup(task, true, outcome);
    await act(async () => {});
    expect(view.queryByRole("navigation", { name: "Labeling task" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "Labeling dataset" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "Taxonomy version" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "Prediction version" })).toBeNull();
    expect(new Set(queriedVersions)).toEqual(new Set([task.version]));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("schema")).toBe(task.version);
    expect(params.get("prediction")).toBe("legacy");
    expect(params.get("episode")).toBe("0");
    expect((view.getByRole("radio", { name: outcome === "success" ? "Success" : "Failure", exact: true }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole("combobox", { name: "End state" }) as HTMLSelectElement).value).toBe("");
    const stages = view.getByRole("combobox", { name: "Stage reached" }) as HTMLSelectElement;
    expect([...stages.options].filter((option) => option.value).map((option) => option.value))
      .toEqual(spec.trajectory.task_definition.stages.slice(1).map((stage) => stage.id));
    expect(state.saves).toHaveLength(0);
    await act(async () => fireEvent.keyDown(window, { key: "u" }));
    expect(state.saves[0].taxonomy_version).toBe(task.version);
    expect(state.saves[0].prediction_id).toBeUndefined();
    expect(state.saves[0].label!.task_success).toBe(outcome === "success");
    expect(state.saves[0].label!.stage_transitions).toEqual([]);
  });

  for (const live of [false, "missing"] as const) test(`${task.name}: ${live === false ? "candidate" : "missing"} definition blocks labeling rather than falling back`, async () => {
    const { view, state } = setup(task, live);
    await act(async () => {});
    expect(view.getByRole("alert").textContent).toContain(task.version);
    expect(view.queryByRole("combobox", { name: "Stage reached" })).toBeNull();
    expect(state.saves).toHaveLength(0);
  });
}
