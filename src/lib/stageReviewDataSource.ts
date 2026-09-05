import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  fetchAppliedProgress,
  fetchEpisodeFrameSignals,
  fetchLabelHistory,
  fetchLedgerArms,
  fetchReviewEpisodes,
} from "./hf-api";

/** Explicit I/O boundary for offline review-flow tests. */
export const stageReviewDataSource = {
  useQuery,
  useMutation,
  usePaginatedQuery,
  fetchAppliedProgress,
  fetchEpisodeFrameSignals,
  fetchLabelHistory,
  fetchLedgerArms,
  fetchReviewEpisodes,
};

export type StageReviewDataSource = typeof stageReviewDataSource;
