/// <reference path="./env.d.ts" />
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Access control for arena writes.
 *
 * Two principals may write:
 *  - Allowlisted humans, signed in with Hugging Face OAuth. The allowlist is
 *    the ARENA_EDITORS env var: comma-separated HF usernames.
 *  - The robot pipeline, presenting the ARENA_SERVICE_TOKEN env var value as
 *    a `serviceToken` mutation argument.
 *
 * Both env vars are required for their respective paths; missing config fails
 * closed with a descriptive error.
 */

function editorAllowlist(): string[] {
  return (process.env.ARENA_EDITORS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Require a signed-in, allowlisted human editor. Returns their HF username. */
export async function requireEditor(
  ctx: QueryCtx | MutationCtx
): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not signed in — this action requires authentication");
  }
  const user = await ctx.db.get(userId);
  const username = user?.username;
  if (!username) {
    throw new Error("Signed-in user has no Hugging Face username on record");
  }
  const allowlist = editorAllowlist();
  if (allowlist.length === 0) {
    throw new Error(
      "ARENA_EDITORS is not configured on this deployment — no editors are allowlisted"
    );
  }
  if (!allowlist.includes(username)) {
    throw new Error(`User "${username}" is not an allowlisted editor`);
  }
  return username;
}

/**
 * Require either a valid service token (robot pipeline) or an allowlisted
 * signed-in editor. Returns the acting principal for audit purposes.
 */
export async function requireEditorOrService(
  ctx: QueryCtx | MutationCtx,
  serviceToken: string | undefined
): Promise<string> {
  if (serviceToken !== undefined) {
    const expected = process.env.ARENA_SERVICE_TOKEN;
    if (!expected) {
      throw new Error(
        "ARENA_SERVICE_TOKEN is not configured on this deployment"
      );
    }
    if (serviceToken !== expected) {
      throw new Error("Invalid service token");
    }
    return "service";
  }
  return requireEditor(ctx);
}

/** Non-throwing check used by the UI to decide whether to show edit affordances. */
export async function viewerIsEditor(ctx: QueryCtx): Promise<boolean> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;
  const user = await ctx.db.get(userId);
  const username = user?.username;
  if (!username) return false;
  return editorAllowlist().includes(username);
}
