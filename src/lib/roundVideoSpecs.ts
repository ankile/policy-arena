import type { EpisodeMetadata } from "./hf-api";

export interface RoundResult {
  policy_id: string;
  policyName: string;
  success: boolean;
  episode_index: number;
  /** Sub-goal marks reached; absent/null on rounds submitted without them. */
  num_subtask_marks?: number | null;
}

type EpisodeWithoutSuccess = Omit<EpisodeMetadata, "success">;

// One video tile in a RoundVideos grid. Each tile carries its OWN dataset +
// camera so a single synchronized grid can mix rollouts from different
// sessions/datasets (the joined-sessions view); single-session callers build
// specs via roundVideoSpecs().
export interface RoundVideoSpec {
  policyName: string;
  success: boolean;
  numSubtaskMarks: number | null;
  maxSubtaskMarks: number; // 0 = binary task
  episodeIndex: number;
  datasetRepo: string;
  cameraKey: string;
  episode: EpisodeWithoutSuccess | null; // null => no metadata for this episode
  badge?: string; // e.g. the session letter in the joined view
}

export function roundVideoSpecs(
  results: RoundResult[],
  datasetRepo: string,
  episodeMap: Map<number, EpisodeWithoutSuccess>,
  cameraKey: string,
  badge?: string,
  maxSubtaskMarks = 0,
): RoundVideoSpec[] {
  return results.map((result) => ({
    policyName: result.policyName,
    success: result.success,
    numSubtaskMarks: result.num_subtask_marks ?? null,
    maxSubtaskMarks,
    episodeIndex: result.episode_index,
    datasetRepo,
    cameraKey,
    episode: episodeMap.get(result.episode_index) ?? null,
    badge,
  }));
}
