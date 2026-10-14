import { convexToJson, jsonToConvex, type Value } from "convex/values";
import type { FunctionArgs } from "convex/server";
import type { api } from "../convex/_generated/api";
import type { stageReviewCoverage } from "../convex/stageReviewCoverage";

export const localReviewStorageKey = "policy-arena-stage-playground-v1";
export const migrationBackupKey = `${localReviewStorageKey}:before-trajectory-v2`;
export type LocalReview = FunctionArgs<typeof api.stageReviews.save> & {
  _id: string; reviewer: string; reviewer_user_id: string; saved_at: number;
  review_coverage?: ReturnType<typeof stageReviewCoverage>;
  /** Browser/export metadata, not a machine-label field or shared mutation arg. */
  local_task_definition_sha256?: string;
  local_migration?: {
    version: "trajectory-v2-carry-forward/v1";
    source_review_id: string;
    source_taxonomy: string;
    source_saved_at: number;
    issues: string[];
    failure_mapping: { from: string; to: string };
  };
};
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export function readLocalReviews(storage: StorageAccess): LocalReview[] {
  const raw = storage.getItem(localReviewStorageKey);
  if (!raw) return [];
  const value = jsonToConvex(JSON.parse(raw));
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || !("_id" in row))) {
    throw new Error("Saved playground data is malformed; originals were not changed.");
  }
  return value as unknown as LocalReview[];
}

/** Call under the browser's storage lock. Re-read so another tab's saves survive. */
export function appendLocalReviews(storage: StorageAccess, additions: LocalReview[], backup = false) {
  const current = readLocalReviews(storage);
  if (backup && storage.getItem(migrationBackupKey) === null) {
    storage.setItem(migrationBackupKey, storage.getItem(localReviewStorageKey) ?? "[]");
  }
  const ids = new Set(current.map((row) => row._id));
  const next = [...current, ...additions.filter((row) => !ids.has(row._id))];
  storage.setItem(localReviewStorageKey, JSON.stringify(convexToJson(next as unknown as Value)));
  return next;
}
