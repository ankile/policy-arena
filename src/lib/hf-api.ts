import { asyncBufferFromUrl, parquetReadObjects, toJson } from "hyparquet";

const DEFAULT_DATASET_ID = "ankile/dp-franka-pick-cube-2026-02-12";
const DATASETS_SERVER = "https://datasets-server.huggingface.co";

const FPS = 15;
const HIDDEN_CAMERA_KEYS = new Set(["observation.images.31078156_left"]);
type EpisodeWithoutSuccess = Omit<EpisodeMetadata, "success">;
type ParquetCacheEntry = {
  episodes: EpisodeWithoutSuccess[];
  cameraKeys: string[];
  successMap: Map<number, boolean>;
  complete: boolean;
};
type EpisodeFrameSummary = {
  effectiveLength: number;
  success: boolean | null;
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

export interface DatasetSourceStats {
  humanFrames: number;
  policyFrames: number;
  episodesWithHumanFrames: Set<number>;
}

export interface DatasetInfo {
  episodes: EpisodeMetadata[];
  cameraKeys: string[];
  sourceStats: DatasetSourceStats | null;
}

function hfBase(datasetId: string): string {
  return `https://huggingface.co/datasets/${datasetId}/resolve/main`;
}

async function listEpisodeMetadataFiles(datasetId: string): Promise<string[]> {
  const url =
    `https://huggingface.co/api/datasets/${datasetId}/tree/main/meta/episodes` +
    "?recursive=true&expand=false&limit=1000";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hugging Face metadata listing returned ${response.status} for ${datasetId}`);
  }
  const entries = (await response.json()) as { path: string; type: string }[];
  const paths = entries
    .filter((entry) => entry.type === "file" && entry.path.endsWith(".parquet"))
    .map((entry) => entry.path)
    .sort();
  if (paths.length === 0) {
    throw new Error(`${datasetId} has no meta/episodes parquet files`);
  }
  return paths;
}

async function readParquet(url: string): Promise<Record<string, unknown>[]> {
  const file = await asyncBufferFromUrl({ url });
  const rows = await parquetReadObjects({ file });
  return rows.map((raw) => toJson(raw) as Record<string, unknown>);
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
    .filter((key) => !HIDDEN_CAMERA_KEYS.has(key))
    .sort();
}

export function visibleCameraKeys(cameraKeys: string[]): string[] {
  return cameraKeys.filter((key) => !HIDDEN_CAMERA_KEYS.has(key));
}

export function selectPrimaryCameraKey(cameraKeys: string[]): string {
  const visibleKeys = visibleCameraKeys(cameraKeys);
  // Prefer the side_1 station view for previews when it exists.
  const sideOne = visibleKeys.find((key) => key.includes("side_1"));
  if (sideOne) return sideOne;
  return visibleKeys.length > 1
    ? visibleKeys[visibleKeys.length - 1]
    : (visibleKeys[0] ?? "");
}

function metadataScalar(row: Record<string, unknown>, key: string): number {
  const raw = row[key];
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : NaN) : raw;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Episode metadata field ${key} must be a finite scalar, got ${JSON.stringify(raw)}`);
  }
  return number;
}

function optionalMetadataScalar(
  row: Record<string, unknown>,
  key: string
): number | null {
  return key in row ? metadataScalar(row, key) : null;
}

/** Recover the exact number of true values in a binary per-frame feature. */
export function binaryTrueCountFromEpisodeStats(
  row: Record<string, unknown>,
  feature: "done" | "is_valid",
  rawLength: number
): number | null {
  const prefix = `stats/${feature}`;
  const keys = [`${prefix}/min`, `${prefix}/max`, `${prefix}/mean`, `${prefix}/count`];
  const present = keys.filter((key) => key in row);
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    throw new Error(`Episode metadata has incomplete ${feature} statistics`);
  }

  const min = metadataScalar(row, `${prefix}/min`);
  const max = metadataScalar(row, `${prefix}/max`);
  const mean = metadataScalar(row, `${prefix}/mean`);
  const count = metadataScalar(row, `${prefix}/count`);
  if (!Number.isInteger(count) || count !== rawLength) {
    throw new Error(`${feature} stats count ${count} does not match episode length ${rawLength}`);
  }
  if (![0, 1].includes(min) || ![0, 1].includes(max) || min > max || mean < 0 || mean > 1) {
    throw new Error(`Episode metadata ${feature} statistics are not binary`);
  }

  const exactCount = mean * count;
  const trueCount = Math.round(exactCount);
  if (Math.abs(exactCount - trueCount) > 1e-6 * Math.max(1, count)) {
    throw new Error(`Episode metadata ${feature} mean does not encode an integer count`);
  }
  if ((max === 0 && trueCount !== 0) || (min === 1 && trueCount !== count)) {
    throw new Error(`Episode metadata ${feature} statistics are internally inconsistent`);
  }
  return trueCount;
}

/**
 * Effective task length: include the first done frame, but exclude the first
 * invalid frame and everything after either boundary.
 *
 * SIR real datasets enforce a binary done suffix and an is_valid prefix. Their
 * episode parquet statistics therefore encode both boundary positions exactly:
 * first_done = raw_length - sum(done), valid_length = sum(is_valid).
 */
export function effectiveEpisodeLengthFromStats(
  row: Record<string, unknown>
): number {
  const rawLength = metadataScalar(row, "length");
  if (!Number.isInteger(rawLength) || rawLength < 1) {
    throw new Error(`Episode length must be a positive integer, got ${rawLength}`);
  }

  const validCount = binaryTrueCountFromEpisodeStats(row, "is_valid", rawLength);
  const doneCount = binaryTrueCountFromEpisodeStats(row, "done", rawLength);
  const validLength = validCount ?? rawLength;
  const doneInclusiveLength =
    doneCount != null && doneCount > 0 ? rawLength - doneCount + 1 : rawLength;
  const effectiveLength = Math.min(validLength, doneInclusiveLength);
  if (effectiveLength < 1 || effectiveLength > rawLength) {
    throw new Error(
      `Invalid effective episode length ${effectiveLength} from raw length ${rawLength}`
    );
  }
  return effectiveLength;
}

export function successFromEpisodeStats(
  row: Record<string, unknown>
): boolean | null {
  const value = optionalMetadataScalar(row, "stats/success/max");
  if (value === null) return null;
  if (value !== 0 && value !== 1) {
    throw new Error(`Episode success statistic must be 0 or 1, got ${value}`);
  }
  return value === 1;
}

export function summarizeEpisodeFrames(
  rows: Record<string, unknown>[],
  episodeIndex: number
): EpisodeFrameSummary {
  if (rows.length === 0) {
    throw new Error(`Episode ${episodeIndex} has no frame rows`);
  }
  const sorted = [...rows].sort(
    (a, b) => metadataScalar(a, "frame_index") - metadataScalar(b, "frame_index")
  );
  for (let index = 0; index < sorted.length; index++) {
    if (metadataScalar(sorted[index], "frame_index") !== index) {
      throw new Error(`Episode ${episodeIndex} has non-contiguous frame indices`);
    }
  }

  let validLength = sorted.length;
  if ("is_valid" in sorted[0]) {
    let seenInvalid = false;
    validLength = 0;
    for (const row of sorted) {
      const value = metadataScalar(row, "is_valid");
      if (value !== 0 && value !== 1) {
        throw new Error(`Episode ${episodeIndex} has non-binary is_valid`);
      }
      if (value === 0) {
        seenInvalid = true;
      } else {
        if (seenInvalid) {
          throw new Error(`Episode ${episodeIndex} has a valid frame after an invalid frame`);
        }
        validLength += 1;
      }
    }
    if (validLength === 0) {
      throw new Error(`Episode ${episodeIndex} has no valid frames`);
    }
  }

  let effectiveLength = validLength;
  if ("done" in sorted[0]) {
    const validDone = sorted
      .slice(0, validLength)
      .map((row) => metadataScalar(row, "done"));
    if (validDone.some((value) => value !== 0 && value !== 1)) {
      throw new Error(`Episode ${episodeIndex} has non-binary done`);
    }
    const firstDone = validDone.indexOf(1);
    if (firstDone >= 0) {
      if (validDone.slice(firstDone).some((value) => value === 0)) {
        throw new Error(`Episode ${episodeIndex} done returns to zero after its terminal frame`);
      }
      effectiveLength = firstDone + 1;
    }
  }

  let success: boolean | null = null;
  if ("success" in sorted[0]) {
    const values = sorted.map((row) => metadataScalar(row, "success"));
    if (values.some((value) => value !== 0 && value !== 1)) {
      throw new Error(`Episode ${episodeIndex} has non-binary success`);
    }
    success = values.some((value) => value === 1);
  }
  return { effectiveLength, success };
}

function needsFrameSummary(row: Record<string, unknown>): boolean {
  const hasOutcome = "stats/success/max" in row;
  const hasBoundary =
    "stats/is_valid/count" in row || "stats/done/count" in row;
  return !hasOutcome || !hasBoundary;
}

async function loadFrameSummaries(
  datasetId: string,
  episodeRows: Record<string, unknown>[]
): Promise<Map<number, EpisodeFrameSummary>> {
  const needed = episodeRows.filter(needsFrameSummary);
  if (needed.length === 0) return new Map();

  const episodesByPath = new Map<string, Set<number>>();
  for (const row of needed) {
    const episodeIndex = metadataScalar(row, "episode_index");
    const chunkIndex = metadataScalar(row, "data/chunk_index");
    const fileIndex = metadataScalar(row, "data/file_index");
    const path =
      `data/chunk-${String(chunkIndex).padStart(3, "0")}/` +
      `file-${String(fileIndex).padStart(3, "0")}.parquet`;
    const episodeIndices = episodesByPath.get(path) ?? new Set<number>();
    episodeIndices.add(episodeIndex);
    episodesByPath.set(path, episodeIndices);
  }

  const summaries = new Map<number, EpisodeFrameSummary>();
  await Promise.all(
    [...episodesByPath].map(async ([path, episodeIndices]) => {
      const frameRows = await readParquet(`${hfBase(datasetId)}/${path}`);
      for (const episodeIndex of episodeIndices) {
        const rows = frameRows.filter(
          (row) => metadataScalar(row, "episode_index") === episodeIndex
        );
        summaries.set(episodeIndex, summarizeEpisodeFrames(rows, episodeIndex));
      }
    })
  );
  return summaries;
}

function parseEpisodeRows(
  rows: Record<string, unknown>[],
  videoColPrefix: string | null,
  frameSummaries: Map<number, EpisodeFrameSummary>
): { episodes: EpisodeWithoutSuccess[]; successMap: Map<number, boolean> } {
  const successMap = new Map<number, boolean>();
  const episodes = rows.map((row) => {
    const episodeIndex = metadataScalar(row, "episode_index");
    const rawLength = metadataScalar(row, "length");
    const frameSummary = frameSummaries.get(episodeIndex);
    const numFrames =
      frameSummary?.effectiveLength ?? effectiveEpisodeLengthFromStats(row);
    const rawFromTimestamp = videoColPrefix
      ? metadataScalar(row, `${videoColPrefix}/from_timestamp`)
      : 0;
    const rawToTimestamp = videoColPrefix
      ? metadataScalar(row, `${videoColPrefix}/to_timestamp`)
      : rawLength / FPS;
    const frameDuration =
      rawToTimestamp > rawFromTimestamp
        ? (rawToTimestamp - rawFromTimestamp) / rawLength
        : 1 / FPS;
    const toTimestamp = rawFromTimestamp + numFrames * frameDuration;
    const success = successFromEpisodeStats(row) ?? frameSummary?.success ?? null;
    if (success !== null) successMap.set(episodeIndex, success);

    return {
      episodeIndex,
      numFrames,
      duration: numFrames * frameDuration,
      videoFileIndex: videoColPrefix
        ? metadataScalar(row, `${videoColPrefix}/file_index`)
        : 0,
      fromTimestamp: rawFromTimestamp,
      toTimestamp,
    };
  });
  return { episodes, successMap };
}

// ── Module-level cache for parquet metadata ──
const parquetCache = new Map<string, ParquetCacheEntry>();

/**
 * Fetch only the parquet metadata needed for a specific set of episode indices.
 * Returns cached results instantly on hit. Fetches parquet files in batches of 4
 * with early termination once all needed episodes are found.
 */
export async function fetchEpisodeSubset(
  datasetId: string,
  neededIndices: Set<number>
): Promise<{ episodes: EpisodeWithoutSuccess[]; cameraKeys: string[] }> {
  // Return full cache hit
  const cached = parquetCache.get(datasetId);
  if (
    cached &&
    (cached.complete ||
      [...neededIndices].every((episodeIndex) =>
        cached.episodes.some((episode) => episode.episodeIndex === episodeIndex)
      ))
  ) {
    return cached;
  }

  // Read the first parquet file to discover camera keys and column schema
  const metadataFiles = await listEpisodeMetadataFiles(datasetId);
  const firstRows = await readParquet(`${hfBase(datasetId)}/${metadataFiles[0]}`);

  const cameraKeys =
    firstRows.length > 0 ? discoverCameraKeys(Object.keys(firstRows[0])) : [];
  const videoColPrefix =
    cameraKeys.length > 0 ? `videos/${cameraKeys[0]}` : null;

  const firstFrameSummaries = await loadFrameSummaries(datasetId, firstRows);
  const firstParsed = parseEpisodeRows(firstRows, videoColPrefix, firstFrameSummaries);
  const allEpisodes = firstParsed.episodes;
  const successMap = firstParsed.successMap;
  const found = new Set(allEpisodes.map((e) => e.episodeIndex));
  let filesRead = 1;

  // Check if we already have all needed episodes
  const allFound = () => [...neededIndices].every((idx) => found.has(idx));

  if (!allFound()) {
    // Fetch additional parquet files in batches of 4, with early termination.
    // Paths come from the Hub tree, so a network/read failure is not mistaken
    // for the end of a guessed numbered sequence.
    const BATCH_SIZE = 4;
    const remainingFiles = metadataFiles.slice(1);
    for (let batchStart = 0; batchStart < remainingFiles.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, remainingFiles.length);
      const batchResults = await Promise.all(
        remainingFiles
          .slice(batchStart, batchEnd)
          .map((path) => readParquet(`${hfBase(datasetId)}/${path}`))
      );
      filesRead += batchResults.length;

      for (const rows of batchResults) {
        const frameSummaries = await loadFrameSummaries(datasetId, rows);
        const parsed = parseEpisodeRows(rows, videoColPrefix, frameSummaries);
        allEpisodes.push(...parsed.episodes);
        for (const [episodeIndex, success] of parsed.successMap) {
          successMap.set(episodeIndex, success);
        }
        for (const ep of parsed.episodes) found.add(ep.episodeIndex);
      }

      if (allFound()) break;
    }
  }

  const result = {
    episodes: allEpisodes.sort((a, b) => a.episodeIndex - b.episodeIndex),
    cameraKeys,
    successMap,
    complete: filesRead === metadataFiles.length,
  };

  // Store in module-level cache
  parquetCache.set(datasetId, result);

  return result;
}

/** Get the module-level parquet cache (for initializing component state). */
export function getParquetCache(): ReadonlyMap<
  string,
  ParquetCacheEntry
> {
  return parquetCache;
}

export async function fetchDatasetInfo(
  datasetId: string = DEFAULT_DATASET_ID
): Promise<DatasetInfo> {
  const [parquetResult, successMap, sourceStats] = await Promise.all([
    fetchParquetMetadata(datasetId),
    fetchSuccessStatus(datasetId),
    fetchSourceStats(datasetId).catch(() => null),
  ]);

  const episodes = parquetResult.episodes.map((ep) => ({
    ...ep,
    success: successMap.get(ep.episodeIndex) ?? false,
  }));

  return { episodes, cameraKeys: parquetResult.cameraKeys, sourceStats };
}

export async function fetchParquetMetadata(
  datasetId: string
): Promise<{ episodes: EpisodeWithoutSuccess[]; cameraKeys: string[] }> {
  // Return from module-level cache if available
  const cached = parquetCache.get(datasetId);
  if (cached?.complete) return cached;

  // Read the first parquet file to discover camera keys and column schema
  const metadataFiles = await listEpisodeMetadataFiles(datasetId);
  const firstRows = await readParquet(`${hfBase(datasetId)}/${metadataFiles[0]}`);

  const cameraKeys =
    firstRows.length > 0 ? discoverCameraKeys(Object.keys(firstRows[0])) : [];

  // Fetch every file explicitly listed by the Hub. Do not cap the sequence:
  // older datasets often shard episode metadata across many small files.
  const additionalResults = await Promise.all(
    metadataFiles
      .slice(1)
      .map((path) => readParquet(`${hfBase(datasetId)}/${path}`))
  );

  const allRows = [...firstRows];
  for (const rows of additionalResults) {
    allRows.push(...rows);
  }

  // Use the first camera key for video timing metadata
  const videoColPrefix =
    cameraKeys.length > 0 ? `videos/${cameraKeys[0]}` : null;

  const frameSummaries = await loadFrameSummaries(datasetId, allRows);
  const parsed = parseEpisodeRows(allRows, videoColPrefix, frameSummaries);

  const result = {
    episodes: parsed.episodes.sort((a, b) => a.episodeIndex - b.episodeIndex),
    cameraKeys,
    successMap: parsed.successMap,
    complete: true,
  };

  // Store in module-level cache
  parquetCache.set(datasetId, result);

  return result;
}

export async function fetchSuccessStatus(
  datasetId: string
): Promise<Map<number, boolean>> {
  if (!parquetCache.get(datasetId)?.complete) {
    await fetchParquetMetadata(datasetId);
  }
  const cached = parquetCache.get(datasetId)!;
  if (cached.successMap.size !== cached.episodes.length) {
    const missing = cached.episodes
      .filter((episode) => !cached.successMap.has(episode.episodeIndex))
      .map((episode) => episode.episodeIndex);
    throw new Error(
      `${datasetId} is missing episode-level stats/success/max for episodes ${missing.join(", ")}`
    );
  }
  return new Map(cached.successMap);
}

export async function fetchSourceStats(
  datasetId: string
): Promise<DatasetSourceStats | null> {
  // Try to get frame counts by source value. If the column doesn't exist, the
  // HF Datasets server returns an error, so we treat any failure as "no source column".
  const base = `${DATASETS_SERVER}/filter?dataset=${datasetId}&config=default&split=train`;

  const [policyResp, humanResp] = await Promise.all([
    fetch(`${base}&where=${encodeURIComponent('"source"=0')}&length=1`),
    fetch(`${base}&where=${encodeURIComponent('"source"=1')}&length=1`),
  ]);

  if (!policyResp.ok || !humanResp.ok) return null;

  const [policyData, humanData] = await Promise.all([
    policyResp.json(),
    humanResp.json(),
  ]);

  // The server returns num_rows_total for the filtered result
  const policyFrames: number | undefined = policyData.num_rows_total;
  const humanFrames: number | undefined = humanData.num_rows_total;
  if (policyFrames == null || humanFrames == null) return null;

  // Paginate through human-source rows to collect unique episode indices
  const episodesWithHumanFrames = new Set<number>();
  if (humanFrames > 0) {
    let offset = 0;
    const pageSize = 100;
    while (offset < humanFrames) {
      const pageResp = await fetch(
        `${base}&where=${encodeURIComponent('"source"=1')}&offset=${offset}&length=${pageSize}`
      );
      if (!pageResp.ok) break;
      const pageData = await pageResp.json();
      for (const { row } of pageData.rows) {
        episodesWithHumanFrames.add(row.episode_index);
      }
      offset += pageSize;
    }
  }

  return { humanFrames, policyFrames, episodesWithHumanFrames };
}
