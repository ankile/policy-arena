import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import ReviewTaskNavigation from "./ReviewTaskNavigation";
import StagePreviewNotice from "./StagePreviewNotice";
import { reviewSamples, reviewSampleHref, latestReviewSearch, type ReviewSample } from "./stageReviewSamples";
import { latestStagePreviews } from "./localStagePreviews";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

for (const task of ["marker_d2", "square_d2", "routing_d1"] as const) test(`${task}: task guide keeps definitions available but collapsed by default`, () => {
  const spec = latestStagePreviews[task];
  window.history.replaceState({}, "", "?schema=older-definition");
  const view = render(<StagePreviewNotice task={task} />);
  const guide = view.getByText("Task guide").closest("details")!;
  expect(view.queryByRole("link")).toBeNull();
  expect(guide.open).toBe(false);
  fireEvent.click(guide.querySelector("summary")!);
  expect(guide.open).toBe(true);
  const causes = within(view.getByRole("region", { name: "Failure causes" }));
  for (const item of spec.trajectory.task_definition.failureModes) expect(causes.getByText(item.description)).toBeTruthy();
  const endpoints = within(view.getByRole("region", { name: "Physical end states" }));
  for (const item of spec.trajectory.task_definition.finalStates) expect(endpoints.getByText(item.description)).toBeTruthy();
});

describe("playground task navigation", () => {
  for (const sample of reviewSamples) test(`${sample.datasetName}: old links open the latest definition without reusing incompatible predictions`, () => {
    const latest = latestStagePreviews[sample.task].taxonomy_version;
    for (const schema of ["", "old-version", "typo"]) {
      const original = new URLSearchParams({ dataset: sample.dataset, episode: "11", prediction: "old-run", schema, sstatus: "all" });
      const normalized = new URLSearchParams(latestReviewSearch(sample, `?${original}`));
      expect(normalized.get("schema")).toBe(latest);
      expect(normalized.get("prediction")).toBe("legacy");
      expect(normalized.get("episode")).toBe("11");
      expect(normalized.get("dataset")).toBe(sample.dataset);
      expect(normalized.get("sstatus")).toBe("all");
      expect(original.get("prediction")).toBe("old-run");
    }
    const current = new URLSearchParams({ dataset: sample.dataset, episode: "11", prediction: "current-run", schema: latest });
    expect(latestReviewSearch(sample, `?${current}`)).toBe(`?${current}`);
    const defaults = new URLSearchParams(latestReviewSearch(sample, ""));
    expect(defaults.get("schema")).toBe(latest);
    expect(defaults.get("dataset")).toBe(sample.dataset);
    expect(defaults.get("episode")).toBe("0");
  });
  for (const current of reviewSamples) {
    test(`one Routing task, including when opening ${current.datasetName}`, () => {
      const selections: ReviewSample[] = [];
      const view = render(<ReviewTaskNavigation current={current} onSelect={(sample) => selections.push(sample)} />);
      const nav = within(view.getByRole("navigation", { name: "Task" }));
      expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(["Routing", "Marker", "Square nut"]);
      expect(view.queryByText("Routing · manual")).toBeNull();
      const selected = nav.getByRole("button", { name: current.taskName });
      expect(selected.getAttribute("aria-current")).toBe("page");
      fireEvent.click(selected);
      expect(selections).toHaveLength(0);
      const dataset = view.queryByRole("combobox", { name: "Dataset" }) as HTMLSelectElement | null;
      expect(dataset?.value ?? null).toBe(current.task === "routing_d1" ? current.dataset : null);
    });
  }

  test("switches routing datasets without mixing their prediction identities", () => {
    const [routing, , , routingManual] = reviewSamples;
    const selections: ReviewSample[] = [];
    const view = render(<ReviewTaskNavigation current={routing} onSelect={(sample) => selections.push(sample)} />);
    const dataset = view.getByRole("combobox", { name: "Dataset" });
    expect(within(dataset).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(dataset, { target: { value: routingManual.dataset } });
    expect(selections).toEqual([routingManual]);
    for (const sample of [routing, routingManual]) {
      const params = new URLSearchParams(reviewSampleHref(sample));
      expect(params.get("dataset")).toBe(sample.dataset);
      expect(params.get("prediction")).toBe(sample.prediction!);
      expect(params.get("episode")).toBe("0");
      expect(params.get("schema")).toBe(latestStagePreviews.routing_d1.taxonomy_version);
    }
  });

  test("other tasks do not inherit a routing prediction", () => {
    const selections: ReviewSample[] = [];
    const view = render(<ReviewTaskNavigation current={reviewSamples[3]} onSelect={(sample) => selections.push(sample)} />);
    for (const name of ["Marker", "Square nut"]) fireEvent.click(view.getByRole("button", { name }));
    expect(selections.map((sample) => sample.task)).toEqual(["marker_d2", "square_d2"]);
    for (const sample of selections) {
      const params = new URLSearchParams(reviewSampleHref(sample));
      expect(params.get("prediction")).toBe("legacy");
      expect(params.get("schema")).toBe(latestStagePreviews[sample.task].taxonomy_version);
    }
  });
});
