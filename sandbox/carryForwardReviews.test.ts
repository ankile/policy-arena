import { expect, test } from "bun:test";
import marker from "../data/stage-review/marker_d2_v6.spec.json";
import square from "../data/stage-review/square_d2_v5.spec.json";
import routing from "../data/stage-review/routing_d1_v4.spec.json";
import { blankTrajectoryReview, normalizeTrajectoryReviewSpec } from "../convex/trajectoryReview";
import { stageReviewCoverage } from "../convex/stageReviewCoverage";
import { planCarryForward } from "./carryForwardReviews";
import { failureDefinitionCorrections } from "./failureDefinitionCorrections";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { appendLocalReviews, readLocalReviews, localReviewStorageKey, migrationBackupKey, type LocalReview } from "./localReviewStore";

function review(spec = marker, maximum = 4, failure = "insertion_orientation_misalignment"): LocalReview {
  const tag = normalizeTrajectoryReviewSpec(spec.trajectory, spec.task, spec.taxonomy_version);
  const label = blankTrajectoryReview(tag, "test/source", 7);
  Object.assign(label, { task_success: false, max_stage: maximum, max_stage_id: tag.task_definition.stages[maximum].id,
    failure_mode: failure, stage_transitions: tag.task_definition.stages.slice(1, maximum + 1).map((stage, index) => ({
      from_stage_id: tag.task_definition.stages[index].id, from_stage_index: index,
      to_stage_id: stage.id, to_stage_index: stage.index, attempt_index: 1,
      time_s: stage.index + 1 / 15, evidence: "original evidence", confidence: "medium",
    })) });
  return { _id: "local-test", task: spec.task, dataset_repo: "test/source", episode_index: 7n,
    taxonomy_version: spec.taxonomy_version, label, notes: "Human note", status: "confirmed", episode_duration_s: 30,
    saved_at: 1000, reviewer: "Local playground", reviewer_user_id: "local-reviewer", review_protocol: "stages-outcome-v2",
    review_coverage: stageReviewCoverage("stages-outcome-v2", "confirmed", true) };
}

for (const spec of [marker, square, routing]) test(`${spec.task}: preserve all compatible stage marks, precision, outcome, and notes`, () => {
  const old = review(spec, 3, "grasp_lost");
  const snapshot = structuredClone(old);
  const { additions, blocked } = planCarryForward([old], 2000);
  expect(blocked).toEqual([]);
  expect(additions).toHaveLength(1);
  const next = additions[0];
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
  expect(next.label!.task_success).toBe(false);
  expect(next.notes).toBe("Human note");
  expect(next.label).not.toHaveProperty("final_state");
  expect(next.status).toBe(spec.task === "routing_d1" ? "draft" : "confirmed");
  expect(next.review_protocol).toBe("stages-outcome-v3");
  expect(next.review_coverage!.reviewed_fields).not.toContain("final_state");
  expect(next.local_migration!.source_review_id).toBe(old._id);
  if (spec.task === "routing_d1") expect(next.local_migration!.issues.join()).toContain("Check clip identity and order");
  expect(old).toEqual(snapshot);
  expect(planCarryForward([old, next]).additions).toEqual([]);
});

test("revisions fold to latest, and another dataset/episode remains independent", () => {
  const first = review();
  const last = { ...first, _id: "local-revision", notes: "Latest human note" };
  const another = { ...first, _id: "local-other", dataset_repo: "test/other" };
  const result = planCarryForward([first, last, another]).additions;
  expect(result).toHaveLength(2);
  expect(result[0].notes).toBe(last.notes);
  expect(result[0].local_migration!.source_review_id).toBe(last._id);
});

for (const status of ["confirmed", "draft", "uncertain", "cleared"]) test(`existing ${status} target is never overwritten`, () => {
  const old = review();
  const target = { ...planCarryForward([old]).additions[0], status };
  expect(planCarryForward([old, target]).additions).toEqual([]);
});

test("ambiguous failure carries stages into draft without inventing a new cause", () => {
  const old = review();
  const next = planCarryForward([old]).additions[0];
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
  expect(next.status).toBe("draft");
  expect(next.label!.failure_mode).toBe("");
  expect(next.local_migration!.issues).toHaveLength(1);
  expect(next.review_coverage!.reviewed_fields).toEqual([]);
});

for (const spec of [marker, square]) test(`${spec.task}: preserve S6 time and outcome but require a seating-time check`, () => {
  const old = review(spec, 6, "none");
  old.label!.task_success = true;
  const next = planCarryForward([old]).additions[0];
  expect(next.label!.max_stage).toBe(6);
  expect(next.label!.max_stage_id).not.toBe(old.label!.max_stage_id);
  expect(next.label!.stage_transitions.map((e: {time_s: number}) => e.time_s))
    .toEqual(old.label!.stage_transitions.map((e: {time_s: number}) => e.time_s));
  expect(next.status).toBe("draft");
  expect(next.label!.task_success).toBe(true);
  expect(next.local_migration!.issues.join()).toContain("S6 timing");
});

test("only unambiguous category implications are carried", () => {
  expect(planCarryForward([review(marker, 5, "insertion_jammed")]).additions[0].label!.failure_mode).toBe("incomplete_insertion");
  expect(planCarryForward([review(marker, 0, "pregrasp_misalignment")]).additions[0].label!.failure_mode).toBe("grasp_not_established");
  expect(planCarryForward([review(routing, 9, "first_clip_seat_lost")]).additions[0].label!.failure_mode).toBe("first_clip_retention_lost");
  const held = planCarryForward([review(marker, 5, "release_not_completed")]).additions[0];
  expect(held.label!.task_success).toBe(false); // Never rewrite the human binary outcome.
  expect(held.label!.failure_mode).toBe("");
  expect(held.status).toBe("draft");
  expect(planCarryForward([review(marker, 4, "false_insertion")]).additions[0].label!.failure_mode).toBe("false_insertion");
  for (const old of [review(marker, 4, "holder_contact_no_insertion"), review(square, 4, "hole_missed_peg"), review(routing, 4, "first_clip_seating_incomplete")]) {
    expect(planCarryForward([old]).additions[0].label!.failure_mode).toBe("");
    expect(planCarryForward([old]).additions[0].status).toBe("draft");
  }
});

for (const task of ["marker_d2", "square_d2", "routing_d1"] as const) test(`${task}: in-place failure refinement preserves stages without silently recertifying old categories`, () => {
  const current = stageReviewRelease[task];
  const pin = failureDefinitionCorrections[task];
  expect(current.trajectory.task_definition_sha256).toBe(pin.targetDefinitionSha256);
  const tag = normalizeTrajectoryReviewSpec(current.trajectory, task, current.taxonomy_version);
  const old = planCarryForward([review({ marker_d2: marker, square_d2: square, routing_d1: routing }[task], 3, "grasp_lost")]).additions[0];
  old.status = "confirmed";
  old.review_coverage = stageReviewCoverage("stages-outcome-v3", "confirmed", true);
  delete old.local_migration;
  old.label!.failure_mode = pin.recheckFailures[0];
  for (const hash of [undefined, pin.previousDefinitionSha256]) {
    old.local_task_definition_sha256 = hash;
    const snapshot = structuredClone(old);
    const { additions, blocked } = planCarryForward([old], 2000);
    expect(blocked).toEqual([]);
    expect(additions).toHaveLength(1);
    const next = additions[0];
    expect(next.taxonomy_version).toBe(old.taxonomy_version);
    expect(next.local_task_definition_sha256).toBe(tag.task_definition_sha256);
    expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
    expect(next.label!.task_success).toBe(false);
    expect(next.label!.failure_mode).toBe("");
    expect(next.status).toBe("draft");
    expect(next.review_coverage!.reviewed_fields).toEqual([]);
    expect(next.notes).toBe(old.notes);
    expect(old).toEqual(snapshot);
    expect(planCarryForward([old, next]).additions).toEqual([]);
  }
  old.local_task_definition_sha256 = pin.targetDefinitionSha256;
  expect(planCarryForward([old]).additions).toEqual([]);
  old.local_task_definition_sha256 = "unknown-source";
  expect(planCarryForward([old]).additions).toEqual([]);
  delete old.local_task_definition_sha256;
  old.status = "cleared";
  expect(planCarryForward([old]).additions).toEqual([]);
});

test("in-place correction preserves previous unresolved migration checks", () => {
  const old = planCarryForward([review(marker, 6, "insertion_jammed")]).additions[0];
  delete old.local_task_definition_sha256;
  const next = planCarryForward([old]).additions[0];
  expect(next.local_migration!.issues.join()).toContain("S6 timing");
  expect(next.local_migration!.issues.join()).toContain("Choose the new failure category");
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
});

for (const failure of ["grasp_not_established", "grasp_lost"]) for (const maximum of [1, 7, 10]) {
  test(`routing ${failure} at S${maximum}: recheck clip ownership without guessing from progress`, () => {
    const current = stageReviewRelease.routing_d1;
    const pin = failureDefinitionCorrections.routing_d1;
    const old = planCarryForward([review(routing, maximum, failure)]).additions[0];
    old.label!.failure_mode = failure;
    old.status = "confirmed";
    old.local_task_definition_sha256 = pin.additionalSources![0].definitionSha256;
    old.review_coverage = stageReviewCoverage("stages-outcome-v3", "confirmed", true);
    delete old.local_migration;
    const snapshot = structuredClone(old);
    const next = planCarryForward([old]).additions[0];
    expect(next.taxonomy_version).toBe(current.taxonomy_version);
    expect(next.status).toBe("draft");
    expect(next.label!.failure_mode).toBe("");
    expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
    expect(next.label!.task_success).toBe(old.label!.task_success);
    expect(next.notes).toBe(old.notes);
    expect(next.local_migration!.issues.join()).toContain("Choose the new failure category");
    expect(old).toEqual(snapshot);
    expect(planCarryForward([old, next]).additions).toEqual([]);
  });
}

test("routing's prior insertion refinement is preserved while changed stage timing needs review", () => {
  const old = planCarryForward([review(routing, 4, "first_clip_seating_incomplete")]).additions[0];
  old.status = "confirmed";
  old.label!.failure_mode = "first_clip_seating_incomplete";
  old.local_task_definition_sha256 = failureDefinitionCorrections.routing_d1.additionalSources![0].definitionSha256;
  const next = planCarryForward([old]).additions[0];
  expect(next.label!.failure_mode).toBe("first_clip_seating_incomplete");
  expect(next.local_migration!.issues.join()).toContain("Check S3/S8 and S4/S9 timing");
  expect(next.local_migration!.issues.join()).not.toContain("Choose the new failure category");
});

for (const success of [true, false]) test(`routing stage clarification preserves ${success ? "success" : "failure"} and marks without silently certifying timing`, () => {
  const pin = failureDefinitionCorrections.routing_d1;
  const old = planCarryForward([review(routing, 9, "first_clip_retention_lost")]).additions[0];
  old.local_task_definition_sha256 = pin.additionalSources![1].definitionSha256;
  old.status = "confirmed";
  old.label!.task_success = success;
  old.label!.failure_mode = success ? "none" : "first_clip_retention_lost";
  old.review_coverage = stageReviewCoverage("stages-outcome-v3", "confirmed", true);
  delete old.local_migration;
  const snapshot = structuredClone(old);
  const next = planCarryForward([old]).additions[0];
  expect(next.status).toBe("draft");
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
  expect(next.label!.max_stage).toBe(9);
  expect(next.label!.task_success).toBe(success);
  expect(next.label!.failure_mode).toBe(old.label!.failure_mode);
  expect(next.notes).toBe(old.notes);
  expect(next.review_coverage!.reviewed_fields).toEqual([]);
  expect(next.local_migration!.issues).toEqual([pin.stageReviewIssue!]);
  expect(next.local_task_definition_sha256).toBe(pin.targetDefinitionSha256);
  expect(old).toEqual(snapshot);
  expect(planCarryForward([old, next]).additions).toEqual([]);
  expect(planCarryForward([{ ...old, status: "cleared" }]).additions).toEqual([]);
  expect(planCarryForward([{ ...old, local_task_definition_sha256: "unknown-source" }]).additions).toEqual([]);
});

for (const clip of ["first", "second"]) test(`${clip} clip: old entry misses need a cause-only recheck after the gross-angle split`, () => {
  const pin = failureDefinitionCorrections.routing_d1;
  const old = planCarryForward([review(routing, 8, `${clip}_clip_engagement_missed`)]).additions[0];
  old.status = "confirmed";
  old.label!.failure_mode = `${clip}_clip_engagement_missed`;
  old.local_task_definition_sha256 = pin.additionalSources![2].definitionSha256;
  old.review_coverage = stageReviewCoverage("stages-outcome-v3", "confirmed", true);
  delete old.local_migration;
  const snapshot = structuredClone(old);
  const next = planCarryForward([old]).additions[0];
  expect(next.status).toBe("draft");
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
  expect(next.label!.task_success).toBe(false);
  expect(next.label!.max_stage).toBe(8);
  expect(next.label!.failure_mode).toBe("");
  expect(next.local_migration!.issues).toHaveLength(1);
  expect(next.local_migration!.issues[0]).toContain("Choose the new failure category");
  expect(next.local_migration!.issues.join()).not.toContain("timing");
  expect(old).toEqual(snapshot);
  expect(planCarryForward([old, next]).additions).toEqual([]);
});

for (const mode of ["none", "first_clip_grasp_lost", "second_clip_seating_incomplete"]) test(`failure-only split preserves compatible ${mode} review without reopening stages`, () => {
  const pin = failureDefinitionCorrections.routing_d1;
  const old = planCarryForward([review(routing, 9, mode)]).additions[0];
  old.status = "confirmed";
  old.label!.task_success = mode === "none";
  old.label!.failure_mode = mode;
  old.local_task_definition_sha256 = pin.additionalSources![2].definitionSha256;
  old.review_coverage = stageReviewCoverage("stages-outcome-v3", "confirmed", true);
  delete old.local_migration;
  const next = planCarryForward([old]).additions[0];
  expect(next.status).toBe("confirmed");
  expect(next.label!.stage_transitions).toEqual(old.label!.stage_transitions);
  expect(next.label!.task_success).toBe(old.label!.task_success);
  expect(next.label!.failure_mode).toBe(mode);
  expect(next.local_migration!.issues).toEqual([]);
  expect(next.local_task_definition_sha256).toBe(pin.targetDefinitionSha256);
  expect(planCarryForward([old, next]).additions).toEqual([]);
});

test("old stage ladders, cleared sources, mismatching identities, and malformed timelines are not relabeled", () => {
  const old = review();
  expect(planCarryForward([{ ...old, taxonomy_version: "trajectory-review/v1/marker_d2/v4" }]).additions).toEqual([]);
  expect(planCarryForward([{ ...old, status: "cleared" }]).additions).toEqual([]);
  const malformed = structuredClone(old); malformed.label!.stage_transitions[0].to_stage_id = "not_a_stage";
  expect(planCarryForward([malformed]).blocked).toHaveLength(1);
  expect(planCarryForward([malformed]).additions).toEqual([]);
  const identity = structuredClone(old); identity.label!.trajectory_identity.taxonomy_version = "marker_d2/v4";
  expect(planCarryForward([identity]).blocked).toHaveLength(1);
});

test("new review is source-free and does not masquerade as a new prediction", () => {
  const old = review();
  Object.assign(old, { prediction_id: "old-model", prediction_sha256: "old-hash", event_links: [] });
  old.label!.failure_events = [{ failure_mode_id: "old-event", time_s: 3 }];
  const next = planCarryForward([old]).additions[0];
  expect(next).not.toHaveProperty("prediction_id");
  expect(next).not.toHaveProperty("event_links");
  expect(next.label!.failure_events).toEqual([]);
  expect(next.label!.trajectory_identity.sample_id).toBe("test/source#episode=7");
});

test("carry-forward cannot upgrade missing coverage or another reviewer's attestation", () => {
  const old = review(marker, 3, "grasp_lost");
  delete old.review_coverage;
  expect(planCarryForward([old]).additions[0].status).toBe("draft");
  expect(planCarryForward([{ ...old, reviewer_user_id: "someone-else" }]).additions).toEqual([]);
});

test("append rereads storage, keeps originals and backup byte-for-byte, and is idempotent", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const old = review(); appendLocalReviews(storage, [old]);
  const original = data.get(localReviewStorageKey)!;
  const additions = planCarryForward([old]).additions;
  appendLocalReviews(storage, additions, true);
  expect(data.get(migrationBackupKey)).toBe(original);
  expect(readLocalReviews(storage)[0]).toEqual(old);
  const concurrent = { ...old, _id: "another-tab" };
  appendLocalReviews(storage, [concurrent]);
  appendLocalReviews(storage, additions, true);
  expect(readLocalReviews(storage).map((row) => row._id)).toEqual([old._id, additions[0]._id, concurrent._id]);
  expect(data.get(migrationBackupKey)).toBe(original);
});

test("backup failure or corrupt storage cannot overwrite original data", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {
    if (key === migrationBackupKey) throw new Error("Quota exceeded"); data.set(key, value);
  } };
  const old = review(); appendLocalReviews(storage, [old]);
  const original = data.get(localReviewStorageKey);
  expect(() => appendLocalReviews(storage, planCarryForward([old]).additions, true)).toThrow("Quota exceeded");
  expect(data.get(localReviewStorageKey)).toBe(original);
  data.set(localReviewStorageKey, "broken JSON");
  expect(() => appendLocalReviews(storage, [old])).toThrow();
  expect(data.get(localReviewStorageKey)).toBe("broken JSON");
});
