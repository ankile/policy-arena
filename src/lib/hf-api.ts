import { asyncBufferFromUrl, parquetReadObjects, toJson } from "hyparquet";

const DEFAULT_DATASET_ID = "ankile/dp-franka-pick-cube-2026-02-12";
const DATASETS_SERVER = "https://datasets-server.huggingface.co";

const FPS = 15;

export interface EpisodeMetadata {
  episodeIndex: number;
  numFrames: number;
  duration: number;
  success: boolean;
  videoFileIndex: number;
  fromTimestamp: number;
  toTimestamp: number;
}

export interface DatasetInfo {
  episodes: EpisodeMetadata[];
  cameraKeys: string[];
}

function hfBase(datasetId: string): string {
  return `https://huggingface.co/datasets/${datasetId}/resolve/main`;
}

export function getVideoUrl(
  cameraKey: string,
  fileIndex: number,
  datasetId: string = DEFAULT_DATASET_ID
): string {
  return `${hfBase(datasetId)}/videos/${cameraKey}/chunk-000/file-${String(fileIndex).padStart(3, "0")}.mp4`;
}

/** Discover camera keys from parquet column names matching videos/<key>/file_index. */
function discoverCameraKeys(columnNames: string[]): string[] {
  const prefix = "videos/";
  const suffix = "/file_index";
  return columnNames
    .filter((col) => col.startsWith(prefix) && col.endsWith(suffix))
    .map((col) => col.slice(prefix.length, -suffix.length))
    .sort();
}

/** Try to read a parquet file, returning null on failure (e.g. 404). */
async function tryReadParquet(
  url: string
): Promise<Record<string, unknown>[] | null> {
  try {
    const file = await asyncBufferFromUrl({ url });
    const rows = await parquetReadObjects({ file });
    return rows.map((raw) => toJson(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function fetchDatasetInfo(
  datasetId: string = DEFAULT_DATASET_ID
): Promise<DatasetInfo> {
  const [parquetResult, successMap] = await Promise.all([
    fetchParquetMetadata(datasetId),
    fetchSuccessStatus(datasetId).catch(() => new Map<number, boolean>()),
  ]);

  const episodes = parquetResult.episodes.map((ep) => ({
    ...ep,
    success: successMap.get(ep.episodeIndex) ?? false,
  }));

  return { episodes, cameraKeys: parquetResult.cameraKeys };
}

async function fetchParquetMetadata(
  datasetId: string
): Promise<{ episodes: Omit<EpisodeMetadata, "success">[]; cameraKeys: string[] }> {
  // Read the first parquet file to discover camera keys and column schema
  const firstUrl = `${hfBase(datasetId)}/meta/episodes/chunk-000/file-000.parquet`;
  const firstFile = await asyncBufferFromUrl({ url: firstUrl });
  const firstRows = (await parquetReadObjects({ file: firstFile })).map(
    (raw) => toJson(raw) as Record<string, unknown>
  );

  const cameraKeys =
    firstRows.length > 0 ? discoverCameraKeys(Object.keys(firstRows[0])) : [];

  // Try to fetch additional parquet files in parallel (up to 20 total)
  const additionalResults = await Promise.all(
    Array.from({ length: 19 }, (_, i) => {
      const url = `${hfBase(datasetId)}/meta/episodes/chunk-000/file-${String(i + 1).padStart(3, "0")}.parquet`;
      return tryReadParquet(url);
    })
  );

  const allRows = [...firstRows];
  for (const rows of additionalResults) {
    if (rows !== null) allRows.push(...rows);
  }

  // Use the first camera key for video timing metadata
  const videoColPrefix =
    cameraKeys.length > 0 ? `videos/${cameraKeys[0]}` : null;

  const episodes = allRows.map((row) => ({
    episodeIndex: row["episode_index"] as number,
    numFrames: row["length"] as number,
    duration: (row["length"] as number) / FPS,
    videoFileIndex: videoColPrefix
      ? (row[`${videoColPrefix}/file_index`] as number)
      : 0,
    fromTimestamp: videoColPrefix
      ? (row[`${videoColPrefix}/from_timestamp`] as number)
      : 0,
    toTimestamp: videoColPrefix
      ? (row[`${videoColPrefix}/to_timestamp`] as number)
      : 0,
  }));

  return {
    episodes: episodes.sort((a, b) => a.episodeIndex - b.episodeIndex),
    cameraKeys,
  };
}

async function fetchSuccessStatus(
  datasetId: string
): Promise<Map<number, boolean>> {
  const url = `${DATASETS_SERVER}/filter?dataset=${datasetId}&config=default&split=train&where=frame_index=0&length=100`;
  const resp = await fetch(url);
  const data = await resp.json();
  const map = new Map<number, boolean>();
  for (const { row } of data.rows) {
    map.set(row.episode_index, row.success === 1);
  }
  return map;
}
