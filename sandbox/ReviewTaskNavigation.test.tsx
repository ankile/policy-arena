import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import ReviewTaskNavigation from "./ReviewTaskNavigation";
import StagePreviewNotice from "./StagePreviewNotice";
import { reviewSamples, reviewSampleHref, type ReviewSample } from "./stageReviewSamples";
import { latestStagePreviews } from "./localStagePreviews";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

for (const task of ["marker_d2", "square_d2", "routing_d1"] as const) test(`${task}: task guide keeps definitions available but collapsed by default`, () => {
  const spec = latestStagePreviews[task];
  window.history.replaceState({}, "", `?schema=${encodeURIComponent(spec.taxonomy_version)}`);
  const view = render(<StagePreviewNotice task={task} />);
  const guide = view.getByText(`Task guide · ${spec.trajectory.task_definition.taxonomyVersion}`).closest("details")!;
  expect(guide.open).toBe(false);
  fireEvent.click(guide.querySelector("summary")!);
  expect(guide.open).toBe(true);
  const causes = within(view.getByRole("region", { name: "Failure causes" }));
  for (const item of spec.trajectory.task_definition.failureModes) expect(causes.getByText(item.description)).toBeTruthy();
  const endpoints = within(view.getByRole("region", { name: "Physical end states" }));
  for (const item of spec.trajectory.task_definition.finalStates) expect(endpoints.getByText(item.description)).toBeTruthy();
});

describe("playground task navigation", () => {
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
