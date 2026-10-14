import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import CarryForwardNotice from "./CarryForwardNotice";
import type { LocalReview } from "./localReviewStore";
import marker from "../data/stage-review/marker_d2_v6.spec.json";
import { blankTrajectoryReview, normalizeTrajectoryReviewSpec } from "../convex/trajectoryReview";
import { planCarryForward } from "./carryForwardReviews";

GlobalRegistrator.register({url: "http://localhost/"});
const {act, cleanup, render, fireEvent} = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());
function original(): LocalReview {
  const label = blankTrajectoryReview(normalizeTrajectoryReviewSpec(marker.trajectory, marker.task, marker.taxonomy_version), "test/repo", 0);
  Object.assign(label, { max_stage: 0, max_stage_id: "initial_state", task_success: false, failure_mode: "progress_stopped" });
  return { _id: "local-source", task: marker.task, dataset_repo: "test/repo", episode_index: 0n,
    taxonomy_version: marker.taxonomy_version, status: "draft", label, saved_at: 1, episode_duration_s: 10,
    reviewer: "Local playground", reviewer_user_id: "local-reviewer" };
}
test("transfer is explicit and failures leave a retryable control", async () => {
  const transfer = mock(async () => { throw new Error("Storage full"); });
  const view = render(<CarryForwardNotice reviews={[original()]} current={undefined} onTransfer={transfer} />);
  expect(transfer).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(view.getByRole("button", {name: "Carry forward 1 saved reviews"})); });
  expect(view.getByRole("alert").textContent).toBe("Storage full");
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(false);
});
test("only unresolved carried drafts show the specific review request", () => {
  const old = original();
  const migrated = planCarryForward([old]).additions[0];
  const view = render(<CarryForwardNotice reviews={[old, migrated]} current={migrated} onTransfer={async () => {}} />);
  expect(view.getByRole("status").textContent).toContain("Choose the new failure category");
  expect(view.queryByRole("button")).toBeNull();
  const confirmed = { ...migrated, status: "confirmed" };
  view.rerender(<CarryForwardNotice reviews={[old, confirmed]} current={confirmed} onTransfer={async () => {}} />);
  expect(view.queryByRole("status")).toBeNull();
});
