import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useState } from "react";
import { TrajectoryVideoTools } from "./TrajectoryVideoTools";
import { TrajectoryLabelForm } from "./TrajectoryLabelForm";
import { TrajectoryEventRail } from "./TrajectoryEventRail";
import { blankTrajectoryReview } from "../../../convex/trajectoryReview";
import type { ExportedStageSpec, StageLabelRow } from "../../../convex/stageConsistency";
import type { TrajectoryEventLink } from "../../../convex/trajectoryEventLinks";
import fixtures from "../../../tests/fixtures/trajectory-review-fixtures.json";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());
const spec = fixtures.synthetic.tasks.find((t) => t.source_name === "routing_d1_v1")!.spec as ExportedStageSpec;

function Fixture({ initial, sourceKey = "A", frame = 90, snap = () => 123 }: { initial?: StageLabelRow; sourceKey?: string; frame?: number; snap?: () => number | null }) {
  const [row, setRow] = useState(initial ?? blankTrajectoryReview(spec.trajectory!, "test/repo", 0));
  const [links, setLinks] = useState<TrajectoryEventLink[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const props = { spec, row, violations: [], frame, markFrame: snap, markDisabled: false, disabled: false, onEdit: setRow,
    onSeekTime: setSeek, eventLinks: links, onEventLinksChange: setLinks, selectedEventKey: selected, onSelectEvent: setSelected, compactEvents: true };
  return <><TrajectoryVideoTools {...props} duration={30} sourceKey={sourceKey} /><TrajectoryEventRail {...props} /><TrajectoryLabelForm {...props} />
    <output data-testid="state">{JSON.stringify({ row, links, selected, seek })}</output></>;
}

test("capture freezes the snapped video timestamp through chooser interaction and Undo is exact", () => {
  const view = render(<Fixture />);
  const before = JSON.parse(view.getByTestId("state").textContent!).row;
  fireEvent.click(view.getByText("Other label / retry"));
  fireEvent.click(view.getByRole("button", { name: "Choose any stage" }));
  expect(view.getByText("Captured at 8.20 s")).toBeTruthy();
  view.rerender(<Fixture frame={200} snap={() => 200} />);
  fireEvent.change(view.getByLabelText("Stage reached"), { target: { value: "controlled_rope_not_at_clip" } });
  fireEvent.click(view.getByRole("button", { name: "Mark at 8.20 s" }));
  const state = JSON.parse(view.getByTestId("state").textContent!);
  expect(state.row.stage_transitions[0].time_s).toBe(8.2);
  expect(state.row.key_action_observations).toEqual(before.key_action_observations);
  expect(state.selected).toBe("transition:0");
  fireEvent.click(view.getByRole("button", { name: "Undo last mark" }));
  expect(JSON.parse(view.getByTestId("state").textContent!).row).toEqual(before);
});

test("unverified frames and stale source choosers cannot create labels", () => {
  const view = render(<Fixture snap={() => null} />);
  fireEvent.click(view.getByText("Other label / retry"));
  fireEvent.click(view.getByRole("button", { name: "Choose any action" }));
  expect(view.queryByRole("group", { name: "Captured moment" })).toBeNull();
  view.rerender(<Fixture />);
  fireEvent.click(view.getByRole("button", { name: "Choose any action" }));
  view.rerender(<Fixture sourceKey="B" />);
  expect(view.queryByRole("group", { name: "Captured moment" })).toBeNull();
  expect(JSON.parse(view.getByTestId("state").textContent!).row.stage_transitions).toEqual([]);
});

test("a timeline mark seeks the video and reveals its compact inspector without editing", () => {
  const initial = structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;
  const view = render(<Fixture initial={initial} />);
  expect(view.queryByRole("group", { name: "Action 1 occurrence 1 time" })).toBeNull();
  fireEvent.click(view.getByText(/^All \d+ marks/));
  fireEvent.click(view.getByRole("button", { name: /Acquire controlled rope grasp at/ }));
  expect(view.getByRole("group", { name: "Action 1 occurrence 1 time" })).toBeTruthy();
  const state = JSON.parse(view.getByTestId("state").textContent!);
  expect(state.seek).toBe(3.75);
  expect(state.row).toEqual(initial);
});

test("moving a conditional action does not retime its related stage", () => {
  const initial = structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;
  const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByText(/^All \d+ marks/));
  fireEvent.click(view.getByRole("button", { name: /Reach first clip mouth region at/ }));
  const group = view.getByRole("group", { name: "Action 2 occurrence 1 time" });
  fireEvent.click(Array.from(group.querySelectorAll("button")).find((b) => b.textContent === "Move to current frame")!);
  const state = JSON.parse(view.getByTestId("state").textContent!);
  expect(state.row.key_action_observations[1].first_time_s).toBe(8.2);
  expect(state.row.stage_transitions).toEqual(initial.stage_transitions);
});

test("default view has one next-stage control and hides the episode-wide form", () => {
  const view = render(<Fixture />);
  expect(view.getByRole("button", { name: "Mark S1 here" })).toBeTruthy();
  expect(Boolean(view.queryByRole("combobox", { name: "Task success" }))).toBe(false);
  // happy-dom does not exclude the contents of a closed native disclosure from
  // role queries. Check the disclosure state explicitly instead.
  expect(view.getByText("Other label / retry").closest("details")!.open).toBe(false);
  fireEvent.click(view.getByRole("tab", { name: "Episode summary" }));
  expect(view.getByRole("combobox", { name: "Task success" })).toBeTruthy();
  expect(Boolean(view.queryByRole("button", { name: "Add transition" }))).toBe(false);
});

test("one-click milestone capture advances only the checked summary, then Undo restores everything", () => {
  const view = render(<Fixture />);
  const before = JSON.parse(view.getByTestId("state").textContent!).row;
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  const after = JSON.parse(view.getByTestId("state").textContent!).row;
  expect(after.stage_transitions).toHaveLength(1);
  expect(after.stage_transitions[0].time_s).toBe(8.2);
  expect(after.max_stage).toBe(1);
  expect(after.key_action_observations).toEqual(before.key_action_observations);
  fireEvent.click(view.getByRole("button", { name: "Undo last mark" }));
  expect(JSON.parse(view.getByTestId("state").textContent!).row).toEqual(before);
});

test("guided correction moves the advertised future mark without duplicating it", () => {
  const initial = structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;
  const view = render(<Fixture initial={initial} frame={0} snap={() => 30} />);
  const before = JSON.parse(view.getByTestId("state").textContent!).row;
  fireEvent.click(view.getByRole("button", { name: "Move S2 to this frame" }));
  const after = JSON.parse(view.getByTestId("state").textContent!).row;
  expect(after.stage_transitions).toHaveLength(before.stage_transitions.length);
  expect(after.stage_transitions[0].time_s).toBe(2);
  expect(after.key_action_observations[0].first_time_s).toBe(2);
  expect(after.max_stage).toBe(before.max_stage);
});

test("starting a retry keeps prior events and makes the new attempt explicit and undoable", () => {
  const view = render(<Fixture />);
  const before = JSON.parse(view.getByTestId("state").textContent!).row;
  fireEvent.click(view.getByText("Other label / retry"));
  fireEvent.click(view.getByRole("button", { name: "Start another attempt" }));
  expect((view.getByLabelText("Work on attempt") as HTMLInputElement).value).toBe("2");
  expect(JSON.parse(view.getByTestId("state").textContent!).row.stage_transitions).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  const after = JSON.parse(view.getByTestId("state").textContent!).row;
  expect(after.stage_transitions[0].attempt_index).toBe(2);
  expect(after.attempt_count).toBe(2);
  expect(after.key_action_observations).toEqual(before.key_action_observations);
});
