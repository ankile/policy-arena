"use node";
import { createSign } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Fixed server-side destination. The browser supplies only the durable job ID.
export const run = internalAction({
  args: { job_id: v.id("labelingJobs") },
  handler: async (ctx, args): Promise<void> => {
    if (!await ctx.runQuery(internal.labelingLab.dispatchRequest, args)) return;
    let phase = "configuration";
    try {
      const name = process.env.LABELING_CLOUD_RUN_JOB;
      if (!name || !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(name)) throw new Error("Invalid fixed Cloud Run job name");
      const key = JSON.parse(process.env.LABELING_DISPATCHER_JSON!);
      if (typeof key.client_email !== "string" || typeof key.private_key !== "string") throw new Error("Dispatcher service account is not configured");
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: key.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 300 })}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
      phase = "token exchange";
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(20_000),
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }) });
      if (!response.ok) throw new Error(`Dispatcher token exchange failed with HTTP ${response.status}`);
      const token = await response.json();
      if (typeof token.access_token !== "string") throw new Error("Dispatcher token exchange returned no access token");
      phase = "Cloud Run invocation";
      const result = await fetch(`https://run.googleapis.com/v2/${name}:run`, { method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { taskCount: 1, containerOverrides: [{ env: [{ name: "LABELING_JOB_ID", value: args.job_id }] }] } }) });
      if (!result.ok) throw new Error(`Cloud Run dispatch returned HTTP ${result.status}`);
      const operation = await result.json();
      if (typeof operation.name !== "string") throw new Error("Cloud Run returned no operation name");
      phase = "execution receipt";
      await ctx.runMutation(internal.labelingLab.dispatched, { ...args, execution: operation.name });
    } catch {
      // Provider response bodies and exception strings can contain credential material.
      // A lost response is ambiguous: never automatically redispatch a paid job.
      console.error(`[labeling-dispatch] Job ${args.job_id} failed during ${phase}`);
      await ctx.runMutation(internal.labelingLab.dispatched, { ...args,
        error: `Dispatch failed during ${phase}. Inspect Cloud Run before recovery; automatic redispatch is disabled because an invocation response can be lost.` });
    }
  },
});
