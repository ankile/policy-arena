import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import PilotQueue from "./PilotQueue";
import {pilotReviewStatus, type PilotSave} from "./pilotReviewStatus";
import pilot from "./data/stage-reference-pilot.json";
import {allReviewSamples} from "./stageReviewSamples";
import {latestStagePreviews} from "./localStagePreviews";

GlobalRegistrator.register({url: "http://localhost/"});
const {cleanup, render, fireEvent} = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

for (const task of ["marker_d2", "square_d2", "routing_d1"] as const) test(`${task}: exposes 20 choices but no model judgments`, () => {
  const rows = pilot.episodes.filter((row) => row.task === task);
  const current = allReviewSamples.find((sample) => sample.dataset === rows[0].dataset)!;
  window.history.replaceState(null, "", `/?episode=${rows[0].episode}`);
  const selected: number[] = [];
  const view = render(<PilotQueue current={current} saves={[]} taxonomy={latestStagePreviews[task].taxonomy_version}
    onSelect={(row) => selected.push(row.episode)} onBrowse={() => {}} />);
  expect(view.getAllByRole("button", {name: /episode \d+,/})).toHaveLength(20);
  expect(view.getAllByRole("button", {name: /episode \d+, success/})).toHaveLength(7);
  expect(view.getAllByRole("button", {name: /episode \d+, failure/})).toHaveLength(13);
  expect(view.container.textContent).toContain("0/20 labeled");
  for (const row of rows) expect(view.container.textContent).not.toContain(row.failureProxy);
  fireEvent.click(view.getByRole("button", {name: "Next →"}));
  expect(selected).toEqual([rows[1].episode]);
});

test("progress uses latest own review with exact dataset, episode and taxonomy", () => {
  const row = pilot.episodes[0];
  const save: PilotSave = {dataset_repo: row.dataset, episode_index: BigInt(row.episode), taxonomy_version: "new", status: "confirmed"};
  expect(pilotReviewStatus([save], row, "new")).toBe("confirmed");
  expect(pilotReviewStatus([save], row, "old")).toBeUndefined();
  expect(pilotReviewStatus([save, {...save, status: "draft"}], row, "new")).toBe("draft");
  expect(pilotReviewStatus([{...save, dataset_repo: "another"}], row, "new")).toBeUndefined();
});

test("carried stages are visible without claiming unresolved reviews are complete", () => {
  const row = pilot.episodes[0];
  const current = allReviewSamples.find((sample) => sample.dataset === row.dataset)!;
  const save: PilotSave = {dataset_repo: row.dataset, episode_index: BigInt(row.episode),
    taxonomy_version: latestStagePreviews[current.task].taxonomy_version, status: "draft", local_migration: {issues: ["Check category"]}};
  const view = render(<PilotQueue current={current} saves={[save]} taxonomy={save.taxonomy_version} onSelect={() => {}} onBrowse={() => {}} />);
  expect(view.container.textContent).toContain("0/20 labeled · 1 carried forward to check");
  expect(view.getByRole("button", {name: /stages carried forward, needs check/}).textContent).toContain("↪");
});
