import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { stageReviewTasks } from "../shared/stageReviewTasks";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import fixtures from "./fixtures/trajectory-review-fixtures.json";
import { blankTrajectoryReview } from "../convex/trajectoryReview";
import { CURRENT_REVIEW_PROTOCOL, reviewProtocolForTask } from "../convex/stageReviewCoverage";
import routingV5 from "../data/stage-review/routing_d1_v5.spec.json";
import { patchStageMark } from "../src/lib/stageTimeline";
import { prepareStageOutcomeLabel } from "../convex/stageOutcomeReview";

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/stageTaskSpecs.ts": () => import("../convex/stageTaskSpecs"),
  "../convex/stageReviews.ts": () => import("../convex/stageReviews"),
};
const service = { serviceToken: "release-test-token" };
let t: ReturnType<typeof convexTest<typeof schema>>;
let oldToken: string | undefined;
beforeEach(() => {
  oldToken = process.env.ARENA_SERVICE_TOKEN;
  process.env.ARENA_SERVICE_TOKEN = service.serviceToken;
  t = convexTest({ schema, modules, transactionLimits: true });
});
afterEach(() => { if (oldToken === undefined) delete process.env.ARENA_SERVICE_TOKEN; else process.env.ARENA_SERVICE_TOKEN = oldToken; });

for (const task of stageReviewTasks) test(`${task.name}: success requires a completed stage, while uncertain reviews preserve the outcome`, async () => {
  const spec = stageReviewRelease[task.task];
  await t.mutation(api.stageTaskSpecs.upsert, { ...service, task: task.task,
    taxonomy_version: task.version, taxonomy_hash: spec.taxonomy_hash, spec, live: true, source: "test-export" });
  const repo = `test/${task.task}`;
  const save = { ...service, reviewer_override: "test-reviewer", task: task.task,
    dataset_repo: repo, taxonomy_version: task.version, episode_index: 0n,
    episode_duration_s: 30, review_protocol: CURRENT_REVIEW_PROTOCOL };
  const successIndex = task.task === "routing_d1" ? 9 : 6;
  let label = prepareStageOutcomeLabel(spec.trajectory, {
    ...blankTrajectoryReview(spec.trajectory, repo, 0), task_success: true,
    max_stage: 0, max_stage_id: spec.trajectory.task_definition.stages[0].id,
  });
  for (const stage of spec.trajectory.task_definition.stages.slice(0, successIndex + 1)) {
    if (stage.index > 0) label = patchStageMark(spec.trajectory, label, null, stage.id, stage.index, 1);
    if (stage.index < successIndex) {
      for (const status of ["confirmed", "corrected"]) {
        await expect(t.mutation(api.stageReviews.save, { ...save, status, label })).rejects.toThrow("completed-task stage");
      }
      const id = await t.mutation(api.stageReviews.save, { ...save, status: "uncertain", label });
      const uncertain = await t.run((ctx) => ctx.db.get(id));
      expect(uncertain!.label).toEqual(label);
      expect(uncertain!.review_coverage!.reviewed_fields).toEqual([]);
    } else {
      const id = await t.mutation(api.stageReviews.save, { ...save, status: "confirmed", label });
      const confirmed = await t.run((ctx) => ctx.db.get(id));
      expect(confirmed!.status).toBe("confirmed");
      expect(confirmed!.label!.task_success).toBe(true);
    }
  }
});

for (const task of stageReviewTasks) test(`${task.name}: existing API publishes the exact release, preserves history, and accepts new scoped reviews`, async () => {
  // Published predecessors: legacy fixtures, or a released trajectory-task/v2 snapshot.
  const prior = fixtures.synthetic.tasks.find((item) => item.spec.taxonomy_version === task.previousVersion) ??
    { spec: [routingV5].find((spec) => spec.taxonomy_version === task.previousVersion)! };
  const current = stageReviewRelease[task.task];
  const publish = (spec: typeof prior.spec | typeof current, live: boolean) =>
    t.mutation(api.stageTaskSpecs.upsert, { ...service, task: task.task, taxonomy_version: spec.taxonomy_version,
      taxonomy_hash: spec.taxonomy_hash, spec, live, source: "test-export" });
  await publish(prior.spec, true);
  const repo = `test/${task.task}`;
  const oldLabel = blankTrajectoryReview(prior.spec.trajectory, repo, 0);
  const oldId = await t.mutation(api.stageReviews.save, { ...service, reviewer_override: "test-reviewer", task: task.task,
    dataset_repo: repo, taxonomy_version: prior.spec.taxonomy_version, episode_index: 0n, status: "draft",
    label: oldLabel, episode_duration_s: 30, review_protocol: reviewProtocolForTask(prior.spec.trajectory.task_definition) });
  const old = await t.run((ctx) => ctx.db.get(oldId));

  expect(current.taxonomy_version).toBe(task.version);
  await publish(current, false); // Registration verifies definition + complete spec content hashes.
  expect((await t.query(api.stageTaskSpecs.liveForTask, { task: task.task }))!.taxonomy_version).toBe(task.previousVersion);
  await publish(current, true);
  expect((await t.query(api.stageTaskSpecs.liveForTask, { task: task.task }))!.spec).toEqual(current);
  await publish(current, true);
  expect(await t.query(api.stageTaskSpecs.forTask, { task: task.task })).toHaveLength(2);

  const label = blankTrajectoryReview(current.trajectory, repo, 0);
  Object.assign(label, { task_success: false, max_stage: 0, max_stage_id: current.trajectory.task_definition.stages[0].id,
    failure_mode: current.failure_modes.find((mode) => mode !== "none") });
  const id = await t.mutation(api.stageReviews.save, { ...service, reviewer_override: "test-reviewer", task: task.task,
    dataset_repo: repo, taxonomy_version: task.version, episode_index: 0n, status: "confirmed", label,
    episode_duration_s: 30, review_protocol: CURRENT_REVIEW_PROTOCOL });
  const saved = await t.run((ctx) => ctx.db.get(id));
  expect(saved!.taxonomy_version).toBe(task.version);
  expect(saved!.label!.task_success).toBe(false);
  expect(saved!.label).not.toHaveProperty("final_state");
  expect(saved!.review_coverage!.excluded_fields).toContain("key_action_observations.*.occurred");
  const save = { ...service, reviewer_override: "test-reviewer", task: task.task,
    dataset_repo: repo, taxonomy_version: task.version, episode_index: 0n, status: "confirmed",
    label, episode_duration_s: 30 };
  await expect(t.mutation(api.stageReviews.save, { ...save, review_protocol: "stages-outcome-v2" })).rejects.toThrow("protocol must match");
  await expect(t.mutation(api.stageReviews.save, { ...save, review_protocol: CURRENT_REVIEW_PROTOCOL,
    label: { ...label, final_state: "unclear" } })).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.get(oldId))).toEqual(old);
});
