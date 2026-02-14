import { asyncBufferFromUrl, parquetReadObjects, toJson } from "hyparquet";

const DATASET_ID = "ankile/dp-franka-pick-cube-2026-02-12";
const HF_BASE = `https://huggingface.co/datasets/${DATASET_ID}/resolve/main`;
const DATASETS_SERVER = "https://datasets-server.huggingface.co";

const FPS = 15;
const NUM_FILES = 4;

export const CAMERA_KEYS = [
  "observation.images.25916956_left",
  "observation.images.18650758_left",
] as const;

export type CameraKey = (typeof CAMERA_KEYS)[number];

export const CAMERA_LABELS: Record<CameraKey, string> = {
  "observation.images.25916956_left": "Camera 2",
  "observation.images.18650758_left": "Camera 1",
};

export interface EpisodeMetadata {
  episodeIndex: number;
  numFrames: number;
  duration: number;
  success: boolean;
  videoFileIndex: number;
  fromTimestamp: number;
  toTimestamp: number;
}

export function getVideoUrl(cameraKey: CameraKey, fileIndex: number): string {
  return `${HF_BASE}/videos/${cameraKey}/chunk-000/file-${String(fileIndex).padStart(3, "0")}.mp4`;
}

export async function fetchEpisodeMetadata(): Promise<EpisodeMetadata[]> {
  const [parquetEpisodes, successMap] = await Promise.all([
    fetchParquetMetadata(),
    fetchSuccessStatus(),
  ]);

  return parquetEpisodes.map((ep) => ({
    ...ep,
    success: successMap.get(ep.episodeIndex) ?? false,
  }));
}

const VIDEO_COL_PREFIX = `videos/${CAMERA_KEYS[0]}`;

async function fetchParquetMetadata(): Promise<
  Omit<EpisodeMetadata, "success">[]
> {
  const results = await Promise.all(
    Array.from({ length: NUM_FILES }, (_, i) => {
      const url = `${HF_BASE}/meta/episodes/chunk-000/file-${String(i).padStart(3, "0")}.parquet`;
      return readEpisodeParquet(url);
    })
  );

  return results.flat().sort((a, b) => a.episodeIndex - b.episodeIndex);
}

async function readEpisodeParquet(
  url: string
): Promise<Omit<EpisodeMetadata, "success">[]> {
  const file = await asyncBufferFromUrl({ url });
  const rows = await parquetReadObjects({
    file,
    columns: [
      "episode_index",
      "length",
      `${VIDEO_COL_PREFIX}/file_index`,
      `${VIDEO_COL_PREFIX}/from_timestamp`,
      `${VIDEO_COL_PREFIX}/to_timestamp`,
    ],
  });

  return rows.map((raw) => {
    const row = toJson(raw) as Record<string, number>;
    return {
      episodeIndex: row["episode_index"],
      numFrames: row["length"],
      duration: row["length"] / FPS,
      videoFileIndex: row[`${VIDEO_COL_PREFIX}/file_index`],
      fromTimestamp: row[`${VIDEO_COL_PREFIX}/from_timestamp`],
      toTimestamp: row[`${VIDEO_COL_PREFIX}/to_timestamp`],
    };
  });
}

async function fetchSuccessStatus(): Promise<Map<number, boolean>> {
  const url = `${DATASETS_SERVER}/filter?dataset=${DATASET_ID}&config=default&split=train&where=frame_index=0&length=100`;
  const resp = await fetch(url);
  const data = await resp.json();
  const map = new Map<number, boolean>();
  for (const { row } of data.rows) {
    map.set(row.episode_index, row.success === 1);
  }
  return map;
}
