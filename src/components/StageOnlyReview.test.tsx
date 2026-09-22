import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useCallback, useState } from "react";
import StageReview from "./StageReview";
import { TrajectoryStageEditor } from "./review/TrajectoryStageEditor";
import { TrajectoryStageRail } from "./review/TrajectoryStageRail";
import { blankTrajectoryReview } from "../../convex/trajectoryReview";
import { validateStageOnlyReview } from "../../convex/stageOnlyReview";
import type { StageLabelRow, ExportedStageSpec } from "../../convex/stageConsistency";
import { createStageReviewFixture, configureTrajectoryFixture } from "../../tests/browser/stageReviewFixture";
import fixtures from "../../tests/fixtures/trajectory-review-fixtures.json";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(async () => { await act(async () => cleanup()); });
afterAll(() => GlobalRegistrator.unregister());
const spec = fixtures.synthetic.tasks.find((t) => t.source_name === "routing_d1_v1")!.spec as ExportedStageSpec;
const real = () => structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;
function Fixture({ initial = blankTrajectoryReview(spec.trajectory!, "test/repo", 0), snap = () => 30 }: { initial?: StageLabelRow; snap?: () => number | null }) {
  const [row, setRow] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const pendingChange = useCallback((_: string, value: boolean) => setPending(value), []);
  const props = { spec, row, frame: 0, disabled: false, markDisabled: false, markFrame: snap,
    onEdit: setRow, onSeekTime: setSeek, selectedEventKey: selected, onSelectEvent: setSelected,
    humanNotes: notes, onHumanNotesChange: setNotes, onPendingInputChange: pendingChange, hasPendingInput: pending,
    violations: validateStageOnlyReview(spec.trajectory!, row, 30) };
  return <><TrajectoryStageRail {...props} /><TrajectoryStageEditor {...props} /><output data-testid="state">{JSON.stringify({ row, seek, selected })}</output></>;
}
const state = (view: ReturnType<typeof render>) => JSON.parse(view.getByTestId("state").textContent!);

test("stage-only controls mark the paused frame, advance the maximum, and undo without touching pipeline fields", () => {
  const view = render(<Fixture />);
  const before = state(view).row;
  expect(view.getByRole("region", { name: "Stage labeling" }).textContent).not.toContain("action");
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  const next = state(view).row;
  expect(next.stage_transitions[0].time_s).toBe(2);
  expect(next.max_stage).toBe(1);
  for (const key of Object.keys(before).filter((key) => !["stage_transitions", "max_stage", "max_stage_id"].includes(key))) expect(next[key]).toEqual(before[key]);
  fireEvent.click(view.getByRole("button", { name: "Undo stage edit" }));
  expect(state(view).row).toEqual(before);
});

test("an existing next-stage mark is moved, not duplicated; its formerly shared action stays unchanged", () => {
  const initial = real(); const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Move S2 to this frame" }));
  expect(state(view).row.stage_transitions).toHaveLength((initial.stage_transitions as unknown[]).length);
  expect(state(view).row.stage_transitions[0].time_s).toBe(2);
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
  expect(state(view).row.failure_events).toEqual(initial.failure_events);
});

test("selecting a stage seeks and editing its label commits immediately without touching other fields", () => {
  const initial = real(); const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  expect(state(view).seek).toBe(3.75);
  fireEvent.change(view.getByRole("combobox", { name: "Stage reached" }), { target: { value: "rope_contact_no_usable_grasp" } });
  expect(state(view).row.stage_transitions[0].to_stage_index).toBe(1);
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
});

test("unfinished time blocks mark switching, removal, and undo; clearing resolves it", () => {
  const view = render(<Fixture initial={real()} />);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  const group = view.getByRole("group", { name: "Transition 1 time" });
  fireEvent.change(group.querySelector("input")!, { target: { value: "-" } });
  expect((view.getByRole("button", { name: "Inspect stage mark 2" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "Remove this mark" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(group.querySelector('[title="Clear stage time"]')!);
  expect((view.getByRole("button", { name: "Remove this mark" }) as HTMLButtonElement).disabled).toBe(false);
  expect(state(view).row.stage_transitions[0].time_s).toBeNull();
});

test("unverified video capture leaves data and unfinished text alone", () => {
  const initial = real(); const view = render(<Fixture initial={initial} snap={() => null} />);
  fireEvent.click(view.getByRole("button", { name: "Move S2 to this frame" }));
  expect(state(view).row).toEqual(initial);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  const input = view.getByRole("group", { name: "Transition 1 time" }).querySelector("input")!;
  fireEvent.change(input, { target: { value: "-" } });
  fireEvent.click(view.getByRole("button", { name: "Move to current frame" }));
  expect(input.value).toBe("-");
  expect(state(view).row).toEqual(initial);
});

test("retries record stages in their own attempt without creating actions or losing old stages", () => {
  const initial = real(); const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Start another attempt" }));
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  expect(state(view).row.stage_transitions.at(-1).attempt_index).toBe(2);
  expect(state(view).row.stage_transitions.slice(0, -1)).toEqual(initial.stage_transitions);
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
});

test("malformed hidden actions do not stop stage capture or leak into the timeline", () => {
  const initial = { ...real(), key_action_observations: "unreadable pipeline-only field", failure_events: null };
  const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Move S2 to this frame" }));
  expect(state(view).row.key_action_observations).toBe(initial.key_action_observations);
  expect(state(view).row.stage_transitions[0].time_s).toBe(2);
});

test("malformed values and retained evidence stay out of the human stage UI", () => {
  const initial = real(); const sentinel = "POLICY_IDENTITY_SENTINEL";
  initial.stage_transitions[0].attempt_index = sentinel;
  initial.stage_transitions[0].evidence = sentinel;
  initial.notes = sentinel; initial.failure_mode = sentinel;
  const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  expect(view.getByRole("region", { name: "Stage labeling" }).innerHTML).not.toContain(sentinel);
  expect(view.getByRole("region", { name: "Stage timeline" }).innerHTML).not.toContain(sentinel);
});

test("removal and chronological repair preserve hidden pipeline records and support exact undo", () => {
  const initial = real(); initial.stage_transitions = [...initial.stage_transitions].reverse();
  const view = render(<Fixture initial={initial} />);
  fireEvent.click(view.getByRole("button", { name: "Order stage marks by time" }));
  expect(state(view).row.stage_transitions.map((e: StageLabelRow) => e.time_s)).toEqual(real().stage_transitions.map((e: StageLabelRow) => e.time_s));
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
  fireEvent.click(view.getByRole("button", { name: "Undo stage edit" }));
  expect(state(view).row).toEqual(initial);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  fireEvent.click(view.getByRole("button", { name: "Remove this mark" }));
  expect(state(view).row.stage_transitions).toHaveLength(initial.stage_transitions.length - 1);
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
  expect(state(view).row.failure_events).toEqual(initial.failure_events);
  fireEvent.click(view.getByRole("button", { name: "Undo stage edit" }));
  expect(state(view).row).toEqual(initial);
});

async function setup(source = "routing_d1_v1", caseName = "real_routing_d1_valid") {
  window.history.replaceState(null, "", "/?episode=0&prediction=A");
  const fixture = createStageReviewFixture(); const contract = configureTrajectoryFixture(fixture, source, caseName);
  const view = render(<StageReview {...fixture.props} />); await act(async () => {});
  return { ...fixture, ...contract, view };
}
for (const task of ["marker_d2", "square_d2", "routing_d1"]) {
  test(`${task}: stage-only review preserves the entire model payload and scopes its saved attestation`, async () => {
    const { view, state: saved, selected } = await setup(`${task}_${task === "routing_d1" ? "v1" : "v3"}`, `real_${task}_valid`);
    expect(Boolean(view.queryByRole("combobox", { name: "Task success" }))).toBe(false);
    expect(view.getByRole("region", { name: "Stage labeling" }).textContent).not.toMatch(/action|failure mode|final state/i);
    expect(saved.saves).toHaveLength(0);
    fireEvent.change(view.getByRole("textbox", { name: "Your review notes" }), { target: { value: "Only stages reviewed." } });
    await act(async () => fireEvent.keyDown(window, { key: "u" }));
    expect(saved.saves[0].label).toEqual(selected.review_label);
    expect(saved.saves[0].review_protocol).toBe("stages-v1");
    expect(saved.saves[0].notes).toBe("Only stages reviewed.");
    expect(saved.saves[0].prediction_id).toBe("A-prediction-0");
  });
}

test("timestamp precision, navigation guards and source attribution survive the simpler UI", async () => {
  const { view, state: saved, selected } = await setup();
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  const input = view.getByRole("group", { name: "Transition 1 time" }).querySelector("input")!;
  fireEvent.change(input, { target: { value: "-" } });
  await act(async () => fireEvent.change(view.getByRole("combobox", { name: "Prediction version" }), { target: { value: "B" } }));
  expect(saved.saves).toHaveLength(0);
  expect(input.value).toBe("-");
  expect(new URLSearchParams(window.location.search).get("prediction")).toBe("A");
  fireEvent.change(input, { target: { value: "3.1234567" } });
  const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => fireEvent.change(view.getByRole("combobox", { name: "Prediction version" }), { target: { value: "B" } }));
  expect(saved.saves[0].label!.stage_transitions[0].time_s).toBe(3.1234567);
  expect(saved.saves[0].label!.key_action_observations).toEqual(selected.review_label!.key_action_observations);
  expect(saved.saves[0].prediction_id).toBe("A-prediction-0");
});

test("source-free annotation still waits for the verified policy duration before labeling", async () => {
  window.history.replaceState(null, "", "/?episode=0&prediction=A");
  const fixture = createStageReviewFixture(); configureTrajectoryFixture(fixture);
  fixture.state.missingPredictionEpisodes.add(0); fixture.state.runs = fixture.state.runs.map((r) => ({ ...r, expected_count: 1 }));
  let release: (() => void) | undefined;
  fixture.state.fetchSignals = () => new Promise((resolve) => { release = () => resolve({ detectedOutcome: "failure", validLength: 120, lastValidFrame: 119, doneOnsetFrame: null, rewardSpikeFrames: [] }); });
  const view = render(<StageReview {...fixture.props} />); await act(async () => {});
  expect(view.container.textContent).toContain("Loading the validated policy-phase duration");
  expect(Boolean(view.queryByTestId("trajectory-form"))).toBe(false);
  await act(async () => release?.());
  expect(view.container.textContent).toContain("policy 8.0s / raw 450f");
  await act(async () => fireEvent.keyDown(window, { key: "u" }));
  expect(fixture.state.saves[0].episode_duration_s).toBe(8);
  expect(fixture.state.saves[0].label!.task_success).toBeNull();
  expect(fixture.state.saves[0].review_protocol).toBe("stages-v1");
});
