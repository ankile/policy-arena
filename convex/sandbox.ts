// Anonymous review is restricted to this disposable deployment, even if the
// environment flag is accidentally copied to the live project.
export const SANDBOX_URL = "https://watchful-swordfish-385.convex.cloud";

export function sandboxEnabled(env = process.env): boolean {
  if (env.ARENA_REVIEW_SANDBOX !== "1") return false;
  if (env.CONVEX_CLOUD_URL !== SANDBOX_URL) {
    throw new Error("Anonymous review requires the isolated stage sandbox deployment");
  }
  return true;
}
