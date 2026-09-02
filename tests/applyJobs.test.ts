import { describe, expect, test } from "bun:test";

import {
  isStaleNativeApplyJob,
  NATIVE_STALE_REAPER_DELAY_MS,
  STALE_APPLYING_MS,
} from "../convex/applyJobs";

describe("native apply stale-job watchdog", () => {
  const now = 1_000_000_000;

  test("reaper runs after the stale threshold", () => {
    expect(NATIVE_STALE_REAPER_DELAY_MS).toBeGreaterThan(STALE_APPLYING_MS);
  });

  test("expires only stale native applying jobs", () => {
    expect(
      isStaleNativeApplyJob(
        {
          status: "applying",
          worker_id: "convex-action",
          started_at: now - STALE_APPLYING_MS - 1,
        },
        now
      )
    ).toBe(true);

    for (const job of [
      {
        status: "applying",
        worker_id: "convex-action",
        started_at: now - STALE_APPLYING_MS,
      },
      {
        status: "applied",
        worker_id: "convex-action",
        started_at: now - STALE_APPLYING_MS - 1,
      },
      {
        status: "applying",
        worker_id: "python-worker",
        started_at: now - STALE_APPLYING_MS - 1,
      },
      null,
    ]) {
      expect(isStaleNativeApplyJob(job, now)).toBe(false);
    }
  });
});
