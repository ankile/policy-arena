import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Lines vs physical tasks (2026-10-20): routing_d2 (mainline) replaced routing_d1
// (retired). A dataset's `task` is its line -- curated per dataset and kept across
// re-registration; its `environment` is the physical task, the spec key. New
// recordings registered as routing_d1 are filed under routing_d2.
const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/datasets.ts": () => import("../convex/datasets"),
  "../convex/datasetStats.ts": () => import("../convex/datasetStats"),
  "../convex/statuses.ts": () => import("../convex/statuses"),
  "../convex/statusShared.ts": () => import("../convex/statusShared"),
  "../convex/access.ts": () => import("../convex/access"),
  "../convex/evalSessions.ts": () => import("../convex/evalSessions"),
};
const SERVICE_TOKEN = "dataset-task-lines-test-only-bridge-token";
const register = (repo_id: string) => ({
  serviceToken: SERVICE_TOKEN, repo_id, name: repo_id, task: "routing_d1",
  environment: "routing_d1", source_type: "eval",
});

describe("dataset task lines", () => {
  let t: TestConvex<typeof schema>;
  let oldServiceToken: string | undefined;
  beforeEach(async () => {
    oldServiceToken = process.env.ARENA_SERVICE_TOKEN;
    process.env.ARENA_SERVICE_TOKEN = SERVICE_TOKEN;
    t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("taskStatuses", { task: "routing_d1", status: "retired", updated_at: 1, updated_by: "t" });
      await ctx.db.insert("taskStatuses", { task: "routing_d2", status: "mainline", updated_at: 1, updated_by: "t" });
      await ctx.db.insert("taskSpecs", {
        task: "routing_d1", task_name: "routing_d1", num_subtask_marks: BigInt(1),
        stored_frame_hw: [BigInt(480), BigInt(640)], camera_keys_by_role: {}, crop_boxes: {},
        exported_at: 1, source: "test",
      });
    });
  });
  afterEach(() => {
    if (oldServiceToken === undefined) delete process.env.ARENA_SERVICE_TOKEN;
    else process.env.ARENA_SERVICE_TOKEN = oldServiceToken;
  });

  test("curated task survives re-registration; new routing_d1 recordings file under routing_d2", async () => {
    await t.mutation(api.datasets.register, register("a/velocity-eval"));
    await t.mutation(api.datasets.register, register("a/umirel-eval"));
    await t.mutation(api.datasets.updateTask, {
      serviceToken: SERVICE_TOKEN, repo_id: "a/umirel-eval", task: "routing_d2", environment: "routing_d1",
    });
    // A resumed eval re-pushes and re-registers with its recorded routing_d1.
    await t.mutation(api.datasets.register, { ...register("a/umirel-eval"), name: "renamed" });
    const umirel = await t.query(api.datasets.getByRepo, { repo_id: "a/umirel-eval" });
    expect(umirel).toMatchObject({ task: "routing_d2", environment: "routing_d1", name: "renamed", effective_status: "mainline" });
    expect(await t.query(api.datasets.getByRepo, { repo_id: "a/velocity-eval" }))
      .toMatchObject({ task: "routing_d1", effective_status: "retired" });

    await t.mutation(internal.statuses.setRegisterNewDatasetsAs, { task: "routing_d1", register_as: "routing_d2" });
    await t.mutation(api.datasets.register, register("a/next-round"));
    expect(await t.query(api.datasets.getByRepo, { repo_id: "a/next-round" }))
      .toMatchObject({ task: "routing_d2", environment: "routing_d1", effective_status: "mainline" });
    // ...and it does not reach back into existing rows.
    await t.mutation(api.datasets.register, register("a/velocity-eval"));
    expect((await t.query(api.datasets.getByRepo, { repo_id: "a/velocity-eval" }))?.task).toBe("routing_d1");

    // Sessions follow the dataset's line; the spec lookup follows its environment.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("evalSessions", { dataset_repo: "a/umirel-eval", num_rounds: BigInt(0), policy_ids: [] }),
    );
    expect(await t.query(api.evalSessions.list, {})).toMatchObject([{ task: "routing_d2", effective_status: "mainline" }]);
    expect(await t.query(api.evalSessions.getDetail, { id: sessionId })).toMatchObject({ max_subtask_marks: 1 });
  });
});
