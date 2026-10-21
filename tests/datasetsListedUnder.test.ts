import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Renamed line (2026-10-20): routing_d1 recordings are listed + status-resolved
// under mainline routing_d2, while dataset.task (the spec key for task/stage
// specs) stays routing_d1 and policies keep their own environment status.
const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/datasets.ts": () => import("../convex/datasets"),
  "../convex/datasetStats.ts": () => import("../convex/datasetStats"),
  "../convex/statuses.ts": () => import("../convex/statuses"),
  "../convex/statusShared.ts": () => import("../convex/statusShared"),
  "../convex/access.ts": () => import("../convex/access"),
  "../convex/evalSessions.ts": () => import("../convex/evalSessions"),
  "../convex/ratings.ts": () => import("../convex/ratings"),
};

describe("datasets_listed_under", () => {
  let t: TestConvex<typeof schema>;
  beforeEach(() => {
    t = convexTest(schema, modules);
  });
  afterEach(() => undefined);

  test("routing_d1 datasets list under mainline routing_d2; overrides still win", async () => {
    await t.run(async (ctx) => {
      const row = (task: string, status: "mainline" | "retired") =>
        ctx.db.insert("taskStatuses", { task, status, updated_at: 1, updated_by: "t" });
      await row("routing_d1", "retired");
      await row("routing_d2", "mainline");
      await row("insert_marker_d1", "retired");
      const dataset = (repo_id: string, task: string, status?: "testing") =>
        ctx.db.insert("datasets", {
          repo_id, name: repo_id, task, environment: task, source_type: "eval",
          ...(status ? { status } : {}),
        });
      await dataset("a/routing-eval", "routing_d1");
      await dataset("a/routing-smoke", "routing_d1", "testing");
      await dataset("a/old-marker", "insert_marker_d1");
    });

    const before = await t.query(api.datasets.list, {});
    expect(before.find((d) => d.repo_id === "a/routing-eval")?.effective_status).toBe("retired");

    await t.mutation(internal.statuses.setDatasetsListedUnder, { task: "routing_d1", listed_under: "routing_d2" });
    const rows = await t.query(api.datasets.list, {});
    const by = new Map(rows.map((d) => [d.repo_id, d]));
    expect(by.get("a/routing-eval")).toMatchObject({ task: "routing_d1", listed_task: "routing_d2", effective_status: "mainline" });
    expect(by.get("a/routing-smoke")).toMatchObject({ listed_task: "routing_d2", effective_status: "testing" });
    expect(by.get("a/old-marker")).toMatchObject({ listed_task: "insert_marker_d1", effective_status: "retired" });
    // Filtering by either the recorded or the listed task finds the dataset.
    expect((await t.query(api.datasets.list, { task: "routing_d2" })).map((d) => d.repo_id).sort())
      .toEqual(["a/routing-eval", "a/routing-smoke"]);
    expect((await t.query(api.datasets.list, { task: "routing_d1" })).length).toBe(2);
    expect(await t.query(api.datasets.getByRepo, { repo_id: "a/routing-eval" }))
      .toMatchObject({ listed_task: "routing_d2", effective_status: "mainline" });

    // Eval sessions on routing_d1 recordings group + resolve as mainline routing_d2
    // in the Sessions list and in the leaderboard ratings feed.
    await t.run(async (ctx) => {
      await ctx.db.insert("evalSessions", { dataset_repo: "a/routing-eval", num_rounds: BigInt(0), policy_ids: [] });
    });
    expect(await t.query(api.evalSessions.list, {})).toMatchObject([{ task: "routing_d2", effective_status: "mainline" }]);
    expect(await t.query(api.ratings.sessionOutcomes, {})).toMatchObject([{ task: "routing_d2", effective_status: "mainline" }]);

    await expect(
      t.mutation(internal.statuses.setDatasetsListedUnder, { task: "routing_d2", listed_under: "routing_d1" }),
    ).rejects.toThrow(/one hop/);
    await t.mutation(internal.statuses.setDatasetsListedUnder, { task: "routing_d1", listed_under: null });
    expect((await t.query(api.datasets.getByRepo, { repo_id: "a/routing-eval" }))?.effective_status).toBe("retired");
  });
});
