import type pilot from "./data/stage-reference-pilot.json";

export type PilotEpisode = (typeof pilot.episodes)[number];
export type PilotSave = {dataset_repo: string; taxonomy_version: string; episode_index: bigint; status: string;
  local_migration?: {issues: string[]}};

export function pilotReviewStatus(saves: PilotSave[], row: PilotEpisode, taxonomy: string) {
  return pilotReview(saves, row, taxonomy)?.status;
}

export function pilotReview(saves: PilotSave[], row: PilotEpisode, taxonomy: string) {
  return [...saves].reverse().find((save) => save.dataset_repo === row.dataset &&
    Number(save.episode_index) === row.episode && save.taxonomy_version === taxonomy);
}
