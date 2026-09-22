import { afterEach, describe, expect, test } from "bun:test";
import { requireEditorOrService, requireReviewerOrService, viewerIsEditor } from "../convex/access";
import { SANDBOX_URL, sandboxEnabled } from "../convex/sandbox";
import type { QueryCtx } from "../convex/_generated/server";

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

function anonymousCtx(): QueryCtx {
  return {
    auth: { getUserIdentity: async () => ({ subject: "test-user" }) },
    db: {
      get: async () => ({ isAnonymous: true, username: "sandbox-reviewer" }),
      query: () => ({ withIndex: () => ({ first: async () => null }) }),
    },
  } as unknown as QueryCtx;
}

describe("isolated review sandbox", () => {
  test("requires both the flag and the exact isolated deployment", () => {
    expect(sandboxEnabled({})).toBe(false);
    expect(sandboxEnabled({ ARENA_REVIEW_SANDBOX: "1", CONVEX_CLOUD_URL: SANDBOX_URL })).toBe(true);
    for (const url of [undefined, "https://grandiose-rook-292.convex.cloud", "https://other.convex.cloud"]) {
      expect(() => sandboxEnabled({ ARENA_REVIEW_SANDBOX: "1", CONVEX_CLOUD_URL: url })).toThrow("isolated");
    }
  });

  test("anonymous reviewers can save reviews but cannot administer or publish", async () => {
    process.env.ARENA_REVIEW_SANDBOX = "1";
    process.env.CONVEX_CLOUD_URL = SANDBOX_URL;
    expect(await viewerIsEditor(anonymousCtx())).toBe(true);
    expect(await requireReviewerOrService(anonymousCtx(), undefined)).toBe("sandbox-reviewer");
    await expect(requireEditorOrService(anonymousCtx(), undefined)).rejects.toThrow("no Hugging Face account");
  });

  test("anonymous review access is denied when sandbox mode is disabled", async () => {
    delete process.env.ARENA_REVIEW_SANDBOX;
    expect(await viewerIsEditor(anonymousCtx())).toBe(false);
    await expect(requireReviewerOrService(anonymousCtx(), undefined)).rejects.toThrow("no Hugging Face account");
  });
});
