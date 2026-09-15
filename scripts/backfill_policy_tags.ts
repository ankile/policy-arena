/** Apply a reviewed manifest through the same authenticated API as manual edits.
 * bun scripts/backfill_policy_tags.ts docs/policy-tags-2026-09-15.json [--apply]
 * Existing classifications must match the manifest or be completely unassigned.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { normalizePolicyTags } from "../convex/policyTags";
import { homedir } from "node:os";

const [path, flag] = process.argv.slice(2);
if (!path || (flag !== undefined && flag !== "--apply")) {
  throw new Error("Usage: bun scripts/backfill_policy_tags.ts <manifest.json> [--apply]");
}
const manifest = await Bun.file(path).json() as {
  entries: { model_id: string; name: string; environment: string; round: number; method: string; tags: string[] }[];
};
const client = new ConvexHttpClient("https://grandiose-rook-292.convex.cloud");
const before = await client.query(api.policies.leaderboard, {});
const byModel = new Map(before.map((p) => [p.model_id, p]));
const seen = new Set<string>();
const pending = manifest.entries.filter((entry) => {
  if (seen.has(entry.model_id)) throw new Error(`Duplicate model: ${entry.model_id}`);
  seen.add(entry.model_id);
  normalizePolicyTags(entry);
  const policy = byModel.get(entry.model_id);
  if (!policy || policy.name !== entry.name || policy.environment !== entry.environment || policy.effective_status !== "mainline") {
    throw new Error(`Policy identity/status changed: ${entry.name}`);
  }
  if (policy.round === entry.round && policy.method === entry.method && JSON.stringify(policy.tags ?? []) === JSON.stringify(entry.tags)) return false;
  if (policy.round !== undefined || policy.method !== undefined || (policy.tags?.length ?? 0) > 0) {
    throw new Error(`Policy already has different tags: ${entry.name}`);
  }
  return true;
});
console.log(`${manifest.entries.length} verified entries; ${pending.length} need tags.`);
if (flag === "--apply") {
  const apiKey = process.env.POLICY_ARENA_API_KEY?.trim()
    || (await Bun.file(`${homedir()}/.config/sir/policy_arena_api_key`).text()).trim();
  if (!apiKey) throw new Error("Policy Arena API key is empty");
  for (const { model_id, round, method, tags } of pending) {
    const response = await fetch("https://grandiose-rook-292.convex.site/api/v1/mutate/policies/setTags", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model_id, round, method, tags }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!response.ok || !result.ok) throw new Error(`Tag update failed: HTTP ${response.status}: ${result.error}`);
  }
  const after = await client.query(api.policies.leaderboard, {});
  for (const entry of manifest.entries) {
    const policy = after.find((p) => p.model_id === entry.model_id);
    if (!policy || policy.round !== entry.round || policy.method !== entry.method || JSON.stringify(policy.tags) !== JSON.stringify(entry.tags)) {
      throw new Error(`Read-back mismatch: ${entry.name}`);
    }
  }
  // Verify the migration touched no unrelated policy fields or policies.
  for (const policy of after) {
    const original = byModel.get(policy.model_id);
    if (!original) continue; // A policy registered concurrently is outside this migration.
    const untouched = (p: typeof policy) => Object.fromEntries(Object.entries(p).filter(([key]) => !seen.has(p.model_id) || !["round", "method", "tags"].includes(key)));
    if (JSON.stringify(untouched(policy)) !== JSON.stringify(untouched(original))) {
      throw new Error(`Non-tag metadata changed during backfill: ${policy.name}`);
    }
  }
  console.log(`Verified all ${manifest.entries.length} classifications; unrelated policy fields unchanged.`);
}
