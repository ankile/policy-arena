/** Test-only loopback HTTP server. Every record lives inside convex-test. */
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import schema from "../../convex/schema";
import fixtures from "../../src/lib/stage-consistency-fixtures.json";
import { sha256Hex } from "../../convex/machineAuth";

const modules = {
  "../../convex/_generated/server.ts": () => import("../../convex/_generated/server"),
  "../../convex/http.ts": () => import("../../convex/http"),
  "../../convex/stagePredictions.ts": () => import("../../convex/stagePredictions"),
  "../../convex/stagePrefills.ts": () => import("../../convex/stagePrefills"),
  "../../convex/stageTaskSpecs.ts": () => import("../../convex/stageTaskSpecs"),
  "../../convex/stageReviews.ts": () => import("../../convex/stageReviews"),
};
process.env.ARENA_SERVICE_TOKEN = "local-integration-only-service-bridge";
process.env.ARENA_EDITOR_SUBS = "local-integration-only-editor";
process.env.POLICY_ARENA_MACHINE_KEYS_JSON = JSON.stringify({
  pa_local_integration: {
    sha256: await sha256Hex("pa_local_integration.test-only-secret-never-valid-on-live"),
    scopes: ["ingest", "curate"],
  },
});
const t = convexTest({ schema, modules, transactionLimits: true });
const fixture = fixtures["routing_d1@s10_v1"];
const spec = fixture.spec;
const cleanLabel = fixture.fixtures.find((item) => item.name === "clean_success")!.row;
const repo = "test/local-python-roundtrip";
await t.run(async (ctx) => {
  await ctx.db.insert("stageTaskSpecs", {
    task: "routing_d1", taxonomy_version: spec.taxonomy_version,
    taxonomy_hash: spec.taxonomy_hash, live: true, spec,
    exported_at: 1, source: "local-integration-test",
  });
  await ctx.db.insert("datasets", {
    repo_id: repo, name: "Local integration test", task: "routing_d1",
    source_type: "eval", environment: "routing_d1", num_episodes: 60n,
  });
  const legacy = await ctx.db.insert("stagePrefills", {
    task: "routing_d1", dataset_repo: repo, episode_index: 0n,
    taxonomy_version: spec.taxonomy_version, label: cleanLabel,
    episode_duration_s: 17, pipeline: { name: "legacy", version: "v1", git_commit: "a".repeat(40) },
    evidence: { preserved: true }, pushed_at: 123, source: "historical-test",
  });
  await ctx.db.insert("stageReviews", {
    task: "routing_d1", dataset_repo: repo, episode_index: 0n,
    taxonomy_version: spec.taxonomy_version, status: "confirmed", label: cleanLabel,
    legacy_prefill_id: legacy, episode_duration_s: 17,
    reviewer: "historical-test-reviewer", saved_at: 123,
  });
});

const counters = { queries: 0, mutations: 0 };
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/_test/fixture") return json({ repo, spec, label: cleanLabel });
    if (path === "/_test/snapshot") {
      const snapshot = await t.run(async (ctx) => ({
        legacy: await ctx.db.query("stagePrefills").collect(),
        specs: await ctx.db.query("stageTaskSpecs").collect(),
        reviews: await ctx.db.query("stageReviews").collect(),
        runs: await ctx.db.query("stagePredictionRuns").collect(),
        predictions: await ctx.db.query("stagePredictions").collect(),
        selections: await ctx.db.query("stagePredictionSelectionHistory").collect(),
        outcomes: await ctx.db.query("outcomeReviews").collect(),
        applyJobs: await ctx.db.query("applyJobs").collect(),
      }));
      return json({ value: convexToJson(snapshot as Value), counters });
    }
    if (path === "/api/query" && request.method === "POST") {
      counters.queries++;
      const body = await request.json();
      if (body.format !== "convex_encoded_json" || !/^(stagePredictions|stagePrefills|stageReviews|stageTaskSpecs):/.test(body.path)) {
        return json({ status: "error", errorMessage: "test query route rejected" }, 400);
      }
      try {
        const result = await t.query(makeFunctionReference<"query">(body.path), jsonToConvex(body.args) as Record<string, Value>);
        return json({ status: "success", value: convexToJson(result as Value), logLines: [] });
      } catch (error) {
        return json({ status: "error", errorMessage: String(error), logLines: [] });
      }
    }
    if (path.startsWith("/api/v1/")) {
      if (path.startsWith("/api/v1/mutate/")) counters.mutations++;
      return t.fetch(path, { method: request.method, headers: request.headers, body: request.method === "POST" ? await request.text() : undefined });
    }
    return json({ error: "test route not found" }, 404);
  },
});
if (!process.argv[2]) throw new Error("Provide a test-only readiness file path");
await Bun.write(process.argv[2], JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
