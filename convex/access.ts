/// <reference path="./env.d.ts" />
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Access control for arena writes.
 *
 * Two principals may write:
 *  - Allowlisted humans, signed in with Hugging Face OAuth. The allowlist is
 *    the ARENA_EDITOR_SUBS env var: comma-separated HF OIDC `sub` values (the
 *    stable account ids stored as authAccounts.providerAccountId). Usernames
 *    are display-only — HF usernames are MUTABLE, so keying authorization on
 *    them would let a rename orphan or impersonate an editor (hardened
 *    2026-08-19 ahead of multi-reviewer stage review; previously
 *    ARENA_EDITORS matched usernames).
 *  - The robot pipeline, presenting the ARENA_SERVICE_TOKEN env var value as
 *    a `serviceToken` mutation argument.
 *
 * Both env vars are required for their respective paths; missing config fails
 * closed with a descriptive error.
 */

function editorSubAllowlist(): string[] {
  return (process.env.ARENA_EDITOR_SUBS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The signed-in user's HF OIDC sub (authAccounts.providerAccountId), or null. */
async function viewerSub(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">
): Promise<string | null> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) =>
      q.eq("userId", userId).eq("provider", "huggingface")
    )
    .unique();
  return account?.providerAccountId ?? null;
}

/** Require a signed-in, allowlisted human editor. Returns their HF username
 * (the display/audit string; authorization itself keys on the OIDC sub). */
export async function requireEditor(
  ctx: QueryCtx | MutationCtx
): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not signed in — this action requires authentication");
  }
  const sub = await viewerSub(ctx, userId);
  if (!sub) {
    throw new Error("Signed-in user has no Hugging Face account id on record");
  }
  const allowlist = editorSubAllowlist();
  if (allowlist.length === 0) {
    throw new Error(
      "ARENA_EDITOR_SUBS is not configured on this deployment — no editors are allowlisted"
    );
  }
  if (!allowlist.includes(sub)) {
    throw new Error(`HF account "${sub}" is not an allowlisted editor`);
  }
  const user = await ctx.db.get(userId);
  return user?.username ?? sub;
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
  const sub = await viewerSub(ctx, userId);
  if (!sub) return false;
  return editorSubAllowlist().includes(sub);
}
