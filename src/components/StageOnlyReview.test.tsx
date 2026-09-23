import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useCallback, useState } from "react";
import StageReview from "./StageReview";
import { TrajectoryStageEditor } from "./review/TrajectoryStageEditor";
import { TrajectoryStageRail } from "./review/TrajectoryStageRail";
import { blankTrajectoryReview } from "../../convex/trajectoryReview";
import { validateStageOnlyReview } from "../../convex/stageOnlyReview";
import { validateStageOutcomeReview } from "../../convex/stageOutcomeReview";
import type { StageLabelRow, ExportedStageSpec } from "../../convex/stageConsistency";
import { createStageReviewFixture, configureTrajectoryFixture } from "../../tests/browser/stageReviewFixture";
import fixtures from "../../tests/fixtures/trajectory-review-fixtures.json";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(async () => { await act(async () => cleanup()); });
afterAll(() => GlobalRegistrator.unregister());
const spec = fixtures.synthetic.tasks.find((t) => t.source_name === "routing_d1_v1")!.spec as ExportedStageSpec;
const real = () => structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;
function Fixture({ schema = spec, initial = blankTrajectoryReview(schema.trajectory!, "test/repo", 0), snap = () => 30 }: { schema?: ExportedStageSpec; initial?: StageLabelRow; snap?: () => number | null }) {
  const [row, setRow] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const pendingChange = useCallback((_: string, value: boolean) => setPending(value), []);
  const props = { spec: schema, row, frame: 0, disabled: false, markDisabled: false, markFrame: snap,
    onEdit: setRow, onSeekTime: setSeek, selectedEventKey: selected, onSelectEvent: setSelected,
    humanNotes: notes, onHumanNotesChange: setNotes, onPendingInputChange: pendingChange, hasPendingInput: pending,
    violations: validateStageOutcomeReview(schema.trajectory!, row, 30) };
  return <><TrajectoryStageEditor {...props} episodeDurationS={12}
    video={<div data-testid="review-player"><video data-testid="review-video" /><input type="range" aria-label="Video position" /></div>}
    timeline={<TrajectoryStageRail {...props} />}
  /><output data-testid="state">{JSON.stringify({ row, seek, selected })}</output></>;
}
const state = (view: ReturnType<typeof render>) => JSON.parse(view.getByTestId("state").textContent!);

for (const task of fixtures.synthetic.tasks) {
  test(`${task.source_name}: every task-defined stage can be captured, retimed and undone`, () => {
    const schema = task.spec as ExportedStageSpec;
    const stages = schema.trajectory!.task_definition.stages.filter((stage) => stage.index > 0);
    let frame = 0;
    const view = render(<Fixture schema={schema} snap={() => frame} />);
    const original = state(view).row;
    const controls = view.getByRole("region", { name: "Stage marking controls" });
    const stageSelect = view.getByRole("combobox", { name: "Stage reached" });
    expect([...stageSelect.querySelectorAll("option")].filter((option) => option.value).map((option) => option.value)).toEqual(stages.map((stage) => stage.id));
    for (const [index, stage] of stages.entries()) {
      if (index > 0) fireEvent.click(view.getByRole("button", { name: "Next stage", exact: true }));
      fireEvent.change(stageSelect, { target: { value: stage.id } });
      frame = stage.index * schema.fps;
      const markButton = view.getByRole("button", { name: `Mark S${stage.index} here`, exact: true });
      expect(controls.contains(markButton)).toBe(true);
      fireEvent.click(markButton);
      expect(state(view).row.stage_transitions.at(-1)).toMatchObject({ to_stage_id: stage.id, to_stage_index: stage.index, time_s: stage.index, attempt_index: 1 });
    }
    const complete = state(view).row;
    expect(complete.stage_transitions).toHaveLength(stages.length);
    expect(complete.max_stage).toBe(stages.at(-1)!.index);
    expect(complete.max_stage_id).toBe(stages.at(-1)!.id);
    expect(validateStageOnlyReview(schema.trajectory!, complete, 30)).toEqual([]);
    for (const key of Object.keys(original).filter((key) => !["stage_transitions", "max_stage", "max_stage_id"].includes(key))) expect(complete[key]).toEqual(original[key]);
    frame++;
    fireEvent.click(view.getByRole("button", { name: "Move to current frame", exact: true }));
    expect(state(view).row.stage_transitions.at(-1).time_s).toBe(frame / schema.fps);
    expect(state(view).row.stage_transitions).toHaveLength(stages.length);
    fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
    expect(state(view).row).toEqual(complete);
  });
}

test("stage capture and retiming stay directly below the player, ahead of the timeline and separate from notes", () => {
  const view = render(<Fixture />);
  const workspace = view.getByTestId("video-labeling-workspace");
  const video = view.getByTestId("review-video");
  const controls = view.getByRole("region", { name: "Stage marking controls" });
  const settings = view.getByRole("complementary", { name: "Episode review settings" });
  expect(controls.previousElementSibling === view.getByTestId("review-player")).toBe(true);
  expect(view.getByRole("region", { name: "Stage timeline" }).previousElementSibling === controls).toBe(true);
  expect(workspace.contains(view.getByRole("combobox", { name: "Stage reached" }))).toBe(true);
  expect(controls.contains(view.getByRole("button", { name: "Mark S1 here" }))).toBe(true);
  expect(workspace.contains(view.getByRole("textbox", { name: "Your review notes" }))).toBe(false);
  expect(settings.contains(view.getByRole("textbox", { name: "Your review notes" }))).toBe(true);
  expect(settings.contains(view.getByRole("combobox", { name: "Furthest stage" }))).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  expect(controls.contains(view.getByRole("group", { name: "Transition 1 time" }))).toBe(true);
  expect(view.getByTestId("review-video") === video).toBe(true);
});

test("stage-only controls mark the paused frame, advance the maximum, and undo without touching pipeline fields", () => {
  const view = render(<Fixture />);
  const before = state(view).row;
  expect(view.getByRole("region", { name: "Stage labeling" }).textContent).not.toContain("action");
  fireEvent.click(view.getByRole("button", { name: "Mark S1 here" }));
  const next = state(view).row;
  expect(next.stage_transitions[0].time_s).toBe(2);
  expect(next.max_stage).toBe(1);
  for (const key of Object.keys(before).filter((key) => !["stage_transitions", "max_stage", "max_stage_id"].includes(key))) expect(next[key]).toEqual(before[key]);
  fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
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
  fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
  expect(state(view).row).toEqual(initial);
  fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
  fireEvent.click(view.getByRole("button", { name: "Remove this mark" }));
  expect(state(view).row.stage_transitions).toHaveLength(initial.stage_transitions.length - 1);
  expect(state(view).row.key_action_observations).toEqual(initial.key_action_observations);
  expect(state(view).row.failure_events).toEqual(initial.failure_events);
  fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
  expect(state(view).row).toEqual(initial);
});

async function setup(source = "routing_d1_v1", caseName = "real_routing_d1_valid", withVideo = false) {
  window.history.replaceState(null, "", "/?episode=0&prediction=A");
  const fixture = createStageReviewFixture(); const contract = configureTrajectoryFixture(fixture, source, caseName);
  if (withVideo) fixture.props.dataSource.fetchReviewEpisodes = async () => [0, 1].map((episodeIndex) => ({
    episodeIndex, rawLength: 450, dataPath: "test.parquet",
    perCamera: { side: { fileIndex: 0, fromTimestamp: 0, toTimestamp: 30 } },
  }));
  const view = render(<StageReview {...fixture.props} />); await act(async () => {});
  return { ...fixture, ...contract, view };
}
for (const task of ["marker_d2", "square_d2", "routing_d1"]) {
  test(`${task}: stage and outcome review preserves the model payload and scopes its saved attestation`, async () => {
    const { view, state: saved, selected } = await setup(`${task}_${task === "routing_d1" ? "v1" : "v3"}`, `real_${task}_valid`);
    expect(view.getByRole("radio", { name: "Success", exact: true })).toBeDefined();
    expect(view.getByRole("combobox", { name: "End state" })).toBeDefined();
    expect(view.getByRole("region", { name: "Stage labeling" }).textContent).not.toMatch(/action|failure mode/i);
    expect(saved.saves).toHaveLength(0);
    fireEvent.change(view.getByRole("textbox", { name: "Your review notes" }), { target: { value: "Only stages reviewed." } });
    await act(async () => fireEvent.keyDown(window, { key: "u" }));
    expect(saved.saves[0].label).toEqual(selected.review_label);
    expect(saved.saves[0].review_protocol).toBe("stages-outcome-v1");
    expect(saved.saves[0].notes).toBe("Only stages reviewed.");
    expect(saved.saves[0].prediction_id).toBe("A-prediction-0");
  });
}

for (const task of fixtures.synthetic.tasks) {
  test(`${task.source_name}: progress-bar stage marks seek, follow edits and undo, and guard unfinished input`, async () => {
    const { view, selected, state: saved } = await setup(task.source_name, "valid_success", true);
    const bar = view.getByRole("group", { name: "Video progress bar" });
    const buttons = () => [...bar.querySelectorAll("button")];
    const events = selected.review_label!.stage_transitions;
    expect(buttons().map((button) => button.textContent)).toEqual(events.map((event) => `S${event.to_stage_index}`));
    expect(bar.textContent).not.toMatch(/action|failure/i);
    const video = view.container.querySelector("video");
    fireEvent.click(buttons()[0]);
    const input = view.getByRole("group", { name: "Transition 1 time" }).querySelector("input")!;
    expect(input.value).toBe(String(events[0].time_s));
    expect(buttons()[0].getAttribute("aria-current")).toBe("step");
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(view.container.textContent).toContain(`frame ${Math.round(events[0].time_s! * task.spec.fps)} /`);
    expect(saved.saves).toHaveLength(0);
    fireEvent.change(input, { target: { value: "-" } });
    expect(buttons().every((button) => button.disabled)).toBe(true);
    fireEvent.change(input, { target: { value: "0.1234567" } });
    expect(buttons()[0].title).toContain("0.12 s");
    expect(buttons().every((button) => !button.disabled)).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
    expect(buttons()[0].title).toContain(`${events[0].time_s!.toFixed(2)} s`);
    expect(view.container.querySelector("video") === video).toBe(true);
  });

  test(`${task.source_name}: a precise stage correction survives save and reload without modifying pipeline fields`, async () => {
    const { view, state: saved, props, selected } = await setup(task.source_name, "valid_success");
    fireEvent.click(view.getByRole("button", { name: "Inspect stage mark 1" }));
    const timeInput = view.getByRole("group", { name: "Transition 1 time" }).querySelector("input")!;
    fireEvent.change(timeInput, { target: { value: "0.1234567" } });
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save draft", exact: true })));
    const review = saved.saves[0];
    expect(review.status).toBe("draft");
    expect(review.review_protocol).toBe("stages-outcome-v1");
    expect(review.taxonomy_version).toBe(task.spec.taxonomy_version);
    expect(review.prediction_id).toBe("A-prediction-0");
    expect(review.label!.stage_transitions[0].time_s).toBe(0.1234567);
    for (const key of Object.keys(selected.review_label!).filter((key) => key !== "stage_transitions")) expect(review.label![key]).toEqual(selected.review_label![key as keyof typeof selected.review_label]);
    view.unmount();
    const reloaded = render(<StageReview {...props} />); await act(async () => {});
    fireEvent.click(reloaded.getByRole("button", { name: "Inspect stage mark 1" }));
    expect(reloaded.getByRole("group", { name: "Transition 1 time" }).querySelector("input")!.value).toBe("0.1234567");
    expect(reloaded.getByRole("region", { name: "Stage labeling" }).textContent).not.toMatch(/action|failure mode/i);
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

for (const task of fixtures.synthetic.tasks) test(`${task.source_name}: source-free annotation waits for verified policy duration without inventing stages`, async () => {
  window.history.replaceState(null, "", "/?episode=0&prediction=A");
  const fixture = createStageReviewFixture(); configureTrajectoryFixture(fixture, task.source_name);
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
  expect(fixture.state.saves[0].label!.stage_transitions).toEqual([]);
  expect(fixture.state.saves[0].label!.max_stage).toBeNull();
  expect(fixture.state.saves[0].taxonomy_version).toBe(task.spec.taxonomy_version);
  expect(fixture.state.saves[0].review_protocol).toBe("stages-outcome-v1");
});

for (const task of fixtures.synthetic.tasks) {
  test(`${task.source_name}: result and end state are editable, undoable and saved without altering hidden fields`, async () => {
    const { view, state: saved, props, selected } = await setup(task.source_name, "valid_success");
    const states = task.spec.trajectory.task_definition.finalStates;
    const finalSelect = view.getByRole("combobox", { name: "End state" });
    expect([...finalSelect.querySelectorAll("option")].filter((option) => option.value).map((option) => option.value)).toEqual(states.filter((item) => task.spec.trajectory.task_definition.successDefinition.successfulFinalStateIds.includes(item.id)).map((item) => item.id));
    expect((view.getByRole("radio", { name: "Success", exact: true }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(view.getByRole("radio", { name: "Failure", exact: true }));
    expect([...finalSelect.querySelectorAll("option")].filter((option) => option.value).map((option) => option.value)).toEqual(states.map((item) => item.id));
    fireEvent.change(finalSelect, { target: { value: states[0].id } });
    expect(view.getByText(states[0].description)).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
    expect((finalSelect as HTMLSelectElement).value).toBe(selected.review_label!.final_state);
    expect((view.getByRole("radio", { name: "Failure", exact: true }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(finalSelect, { target: { value: states[0].id } });
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save draft", exact: true })));
    const review = saved.saves[0];
    expect(review.review_protocol).toBe("stages-outcome-v1");
    expect(review.label!.task_success).toBe(false);
    expect(review.label!.final_state).toBe(states[0].id);
    expect(Object.keys(review.label!)).toEqual(Object.keys(selected.review_label!));
    for (const key of Object.keys(selected.review_label!).filter((key) => !["task_success", "final_state"].includes(key))) {
      expect(review.label![key]).toEqual(selected.review_label![key as keyof typeof selected.review_label]);
    }
    view.unmount();
    const reloaded = render(<StageReview {...props} />); await act(async () => {});
    expect((reloaded.getByRole("radio", { name: "Failure", exact: true }) as HTMLInputElement).checked).toBe(true);
    expect((reloaded.getByRole("combobox", { name: "End state" }) as HTMLSelectElement).value).toBe(states[0].id);
  });
}

for (const task of fixtures.synthetic.tasks) test(`${task.source_name}: success filters end states without overwriting a conflicting selection`, () => {
  const schema = task.spec as ExportedStageSpec;
  const definition = schema.trajectory!.task_definition;
  const initial = { ...blankTrajectoryReview(schema.trajectory!, "test/repo", 0), task_success: false, final_state: definition.finalStates[0].id };
  const view = render(<Fixture schema={schema} initial={initial} />);
  const select = view.getByRole("combobox", { name: "End state" }) as HTMLSelectElement;
  const choices = () => [...select.options].filter((option) => option.value && !option.disabled).map((option) => option.value);
  const successful = definition.finalStates.filter((item) => definition.successDefinition.successfulFinalStateIds.includes(item.id)).map((item) => item.id);
  fireEvent.click(view.getByRole("radio", { name: "Success", exact: true }));
  expect(choices()).toEqual(successful);
  expect(select.value).toBe(initial.final_state);
  expect(select.selectedOptions[0].disabled).toBe(true);
  expect(select.getAttribute("aria-invalid")).toBe("true");
  expect(state(view).row).toEqual({ ...initial, task_success: true });
  fireEvent.change(select, { target: { value: successful[0] } });
  expect(select.getAttribute("aria-invalid")).toBeNull();
  expect(state(view).row).toEqual({ ...initial, task_success: true, final_state: successful[0] });
  fireEvent.click(view.getByRole("button", { name: "Undo last edit" }));
  expect(select.value).toBe(initial.final_state);
  expect(choices()).toEqual(successful);
  fireEvent.click(view.getByRole("radio", { name: "Not sure yet" }));
  expect(choices()).toEqual(definition.finalStates.map((item) => item.id));
  expect(state(view).row).toEqual({ ...initial, task_success: null });
});

test("watch ending seeks to the last policy frame; undecided outcomes stay explicit", () => {
  const view = render(<Fixture />);
  fireEvent.click(view.getByRole("button", { name: "Watch ending" }));
  expect(state(view).seek).toBe(12 - 1 / spec.fps);
  expect((view.getByRole("radio", { name: "Not sure yet" }) as HTMLInputElement).checked).toBe(true);
  expect(view.getByText("Choose Success or Failure, or save as uncertain if you cannot decide.", { selector: "div[aria-label='Result checklist'] p" })).toBeDefined();
  fireEvent.click(view.getByRole("radio", { name: "Success", exact: true }));
  expect(state(view).row.task_success).toBe(true);
  fireEvent.click(view.getByRole("radio", { name: "Not sure yet" }));
  expect(state(view).row.task_success).toBeNull();
  expect(state(view).row.final_state).toBe("");
});
