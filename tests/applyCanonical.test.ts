/**
 * Re-applying an already-applied review record must be a byte-level no-op on
 * state another tool (the Python editor, the robot recorder) wrote, and every
 * file the apply does rewrite must keep Python's json formatting. Regressions
 * from the 2026-10-01 canonicalization pass:
 *  - reward stats computed in float32 by the Python editor were rewritten at
 *    float64 on every apply (md2 R5 repeat, routing R9 blind-dagger);
 *  - progress-record key order (Python insertion order) was re-sorted
 *    (md2 R5 repeat: episode 50 re-reviewed after a skip);
 *  - integral floats in results.json (`args` 30.0, success_rate 1.0) were
 *    re-serialized as ints (square R5 redo).
 */

import { describe, expect, test } from "bun:test";
import { Field, Float32, Float64, Int64, List, Schema, Table, Utf8, makeTable, vectorFromArray } from "apache-arrow";
import { headlessApply, statCellMatches } from "../convex/apply/pipeline";
import type { FileStore } from "../convex/apply/pipeline";
import { listCell, patchListColumns, readArrowTable, writeArrowTable } from "../convex/apply/parquetIO";
import { STAT_KEYS } from "../convex/apply/stats";
import type { Overlay } from "../convex/apply/progress";

const FRAMES = 50;
const EPISODES = 3;
const DATA_PATH = "data/chunk-000/file-000.parquet";
const META_PATH = "meta/episodes/chunk-000/file-000.parquet";

function dataFile(): Uint8Array {
  const n = FRAMES * EPISODES;
  const ints = (f: (i: number) => number) =>
    vectorFromArray(BigInt64Array.from({ length: n }, (_, i) => BigInt(f(i))), new Int64());
  const table = makeTable({
    success: ints(() => 0),
    reward: vectorFromArray(new Float32Array(n), new Float32()),
    done: ints(() => 0),
    is_valid: ints(() => 1),
    frame_index: ints((i) => i % FRAMES),
    episode_index: ints((i) => Math.floor(i / FRAMES)),
  });
  return writeArrowTable(
    new Table(new Schema(table.schema.fields, new Map([["huggingface", "{}"]])), table.batches)
  );
}

function metaFile(): Uint8Array {
  const listOf = (child: Float64 | Int64 | Utf8) => new List(new Field("item", child, true));
  const cols: Record<string, ReturnType<typeof vectorFromArray>> = {
    episode_index: vectorFromArray(BigInt64Array.from({ length: EPISODES }, (_, i) => BigInt(i)), new Int64()),
    "data/chunk_index": vectorFromArray(new BigInt64Array(EPISODES), new Int64()),
    "data/file_index": vectorFromArray(new BigInt64Array(EPISODES), new Int64()),
    tasks: vectorFromArray(
      Array.from({ length: EPISODES }, () => ["test task"]),
      listOf(new Utf8())
    ),
  };
  for (const feat of ["success", "reward", "done", "is_valid"]) {
    for (const key of STAT_KEYS) {
      cols[`stats/${feat}/${key}`] =
        key === "count"
          ? vectorFromArray(
              Array.from({ length: EPISODES }, () => BigInt64Array.from([BigInt(FRAMES)])),
              listOf(new Int64())
            )
          : vectorFromArray(
              Array.from({ length: EPISODES }, () => Float64Array.from([key === "max" ? 1 : 0])),
              listOf(new Float64())
            );
    }
  }
  return writeArrowTable(makeTable(cols as never));
}

/** results.json exactly as Python json.dumps(indent=2, sort_keys=True) writes it. */
const RESULTS_TEXT = `{
  "args": {
    "note": "caf\\u00e9 \\u2014 run",
    "retry_delay_s": 30.0,
    "tiny": 1e-05
  },
  "rollouts": [
    {
      "episode_index": 0,
      "num_steps": 50,
      "outcome": "timeout",
      "policy_id": 0
    },
    {
      "episode_index": 1,
      "num_steps": 50,
      "outcome": "failure",
      "policy_id": 0
    },
    {
      "episode_index": 2,
      "num_steps": 50,
      "outcome": "failure",
      "policy_id": 1
    }
  ],
  "summary": [
    {
      "failures": 2,
      "policy_id": 0,
      "success_rate": 0.0,
      "successes": 0
    },
    {
      "failures": 1,
      "policy_id": 1,
      "success_rate": 0.0,
      "successes": 0
    }
  ]
}
`;

/** Progress record in Python insertion order: episode 1 re-reviewed after a skip. */
const PROGRESS_TEXT = `{
  "changed_episodes": {
    "2": {
      "new_outcome": "success",
      "outcome_frame": 30,
      "soft_truncate": false
    },
    "1": {
      "new_outcome": "success",
      "outcome_frame": 20,
      "soft_truncate": false
    }
  },
  "skipped_episodes": [
    0
  ]
}`;

function overlay(): Overlay {
  return {
    changed_episodes: {
      "1": { new_outcome: "success", outcome_frame: 20, soft_truncate: false },
      "2": { new_outcome: "success", outcome_frame: 30, soft_truncate: false },
    },
    skipped_episodes: [0],
  };
}

function storeOf(files: Map<string, Uint8Array | string>): FileStore {
  return {
    paths: [...files.keys()],
    fetch: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`missing ${p}`);
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
  };
}

async function apply(files: Map<string, Uint8Array | string>) {
  return headlessApply({
    store: storeOf(files),
    overlay: overlay(),
    provenance: null,
    preApplySha: "0".repeat(40),
    taskSpecs: [],
  });
}

function rawSnapshot(): Map<string, Uint8Array | string> {
  return new Map<string, Uint8Array | string>([
    [DATA_PATH, dataFile()],
    [META_PATH, metaFile()],
    ["results.json", RESULTS_TEXT],
    [".outcome_edit_progress.json", PROGRESS_TEXT],
  ]);
}

/** Overwrite every float stats cell with its float32 rounding: the precision
 * regime the Python editor / robot recorder write for float32 features. */
function float32StatsMeta(buf: Uint8Array): Uint8Array {
  const table = readArrowTable(buf);
  const patches = new Map<string, Map<number, number[]>>();
  for (const field of table.schema.fields) {
    if (!field.name.startsWith("stats/") || field.name.endsWith("/count")) continue;
    const rows = new Map<number, number[]>();
    for (let r = 0; r < table.numRows; r++) rows.set(r, listCell(table, field.name, r).map(Math.fround));
    patches.set(field.name, rows);
  }
  return writeArrowTable(patchListColumns(table, patches));
}

describe("re-apply canonical state", () => {
  test("first apply keeps Python json formatting and progress key order", async () => {
    const first = await apply(rawSnapshot());
    expect(first.changedFiles.get(".outcome_edit_progress.json")).toBe(PROGRESS_TEXT);
    const results = first.changedFiles.get("results.json") as string;
    // Integral floats stay floats, computed success_rate is a float, ensure_ascii.
    expect(results).toContain('"retry_delay_s": 30.0,');
    expect(results).toContain('"tiny": 1e-05');
    expect(results).toContain('"note": "caf\\u00e9 \\u2014 run"');
    expect(results).toContain('"success_rate": 1.0');
    expect(results).toContain('"success_rate": 0.5');
    // The eval-time backup is the raw payload, byte-identical to the Python dump.
    expect(first.changedFiles.get("results_eval_time.json")).toBe(RESULTS_TEXT);
  });

  test("re-apply on float32-precision stats and an applied record is a no-op", async () => {
    const first = await apply(rawSnapshot());
    const applied = rawSnapshot();
    for (const [path, content] of first.changedFiles) applied.set(path, content);
    applied.set(META_PATH, float32StatsMeta(applied.get(META_PATH) as Uint8Array));
    const progressBefore = applied.get(".outcome_edit_progress.json");

    const second = await apply(applied);
    expect([...second.changedFiles.keys()].sort()).toEqual([".outcome_edit_progress.json"]);
    expect(second.changedFiles.get(".outcome_edit_progress.json")).toBe(progressBefore);
  });

  test("a stats group off beyond precision noise is rewritten whole", async () => {
    const first = await apply(rawSnapshot());
    const applied = rawSnapshot();
    for (const [path, content] of first.changedFiles) applied.set(path, content);
    const meta = readArrowTable(applied.get(META_PATH) as Uint8Array);
    const exactQ99 = listCell(meta, "stats/reward/q99", 2)[0];
    // Episode 2's stored reward mean is stale (e.g. data clobbered after apply);
    // its q99 carries only float32 noise.
    applied.set(
      META_PATH,
      writeArrowTable(
        patchListColumns(
          meta,
          new Map([
            ["stats/reward/mean", new Map([[2, [0.25]]])],
            ["stats/reward/q99", new Map([[2, [Math.fround(exactQ99)]]])],
          ])
        )
      )
    );
    const second = await apply(applied);
    const out = readArrowTable(second.changedFiles.get(META_PATH) as Uint8Array);
    expect(listCell(out, "stats/reward/mean", 2)[0]).toBeCloseTo(20 / 50, 12);
    // The whole group is recomputed — the noisy q99 too, back to the exact value.
    expect(listCell(out, "stats/reward/q99", 2)[0]).toBe(exactQ99);
    // Other episodes' groups untouched.
    expect(listCell(out, "stats/reward/mean", 1)).toEqual(listCell(meta, "stats/reward/mean", 1));
  });

  test("statCellMatches: precision noise matches, real drift and count changes do not", () => {
    expect(statCellMatches(0.014466546475887299, 0.014466546112115732, false)).toBe(true);
    expect(statCellMatches(-1.000000013351432e-10, -1e-10, false)).toBe(true);
    expect(statCellMatches(0.014466546112115732, 0.014466546112115732 + 1 / 2000, false)).toBe(false);
    expect(statCellMatches(50, 50, true)).toBe(true);
    expect(statCellMatches(50, 49, true)).toBe(false);
  });
});
