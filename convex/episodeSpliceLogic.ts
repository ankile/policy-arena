/**
 * Pure planning for an episode splice: episodes were physically removed from a
 * dataset on the Hub (sir `repair_eval_dataset --drop-episodes`), the survivors
 * renumbered dense, and every Arena row keyed by (dataset, episode_index) must
 * follow. Runtime-neutral (no ctx), shared by the episodeSplice query/mutation
 * and unit-tested on its own.
 */

export interface SpliceRow {
  table: string;
  id: string;
  episode_index: number;
}

export interface SplicePlan {
  /** Rows whose episode_index moves (old -> new). */
  patches: Array<SpliceRow & { new_episode_index: number }>;
  /** Rows of removed episodes. */
  deletes: SpliceRow[];
  unchanged: number;
  /** Order-independent digest of the PRE-splice (table, id, episode_index) set. */
  fingerprint: string;
}

/** old episode_index -> new index (dense renumber), or null for a removed episode. */
export function spliceIndexMap(totalBefore: number, drop: number[]): Map<number, number | null> {
  if (!Number.isInteger(totalBefore) || totalBefore <= 0) {
    throw new Error(`total_before must be a positive integer, got ${totalBefore}`);
  }
  const dropped = new Set(drop);
  if (dropped.size !== drop.length) throw new Error(`duplicate episodes in drop list ${drop}`);
  if (dropped.size === 0) throw new Error("empty drop list");
  for (const ep of dropped) {
    if (!Number.isInteger(ep) || ep < 0 || ep >= totalBefore) {
      throw new Error(`drop episode ${ep} outside 0..${totalBefore - 1}`);
    }
  }
  const map = new Map<number, number | null>();
  let next = 0;
  for (let ep = 0; ep < totalBefore; ep++) {
    if (dropped.has(ep)) map.set(ep, null);
    else map.set(ep, next++);
  }
  return map;
}

/** FNV-1a 64 over the sorted row keys: a re-run after the splice sees a different set. */
export function rowsFingerprint(rows: SpliceRow[]): string {
  const keys = rows.map((r) => `${r.table}:${r.id}:${r.episode_index}`).sort();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      hash ^= BigInt(key.charCodeAt(i));
      hash = (hash * prime) & 0xffffffffffffffffn;
    }
    hash ^= 0x0an;
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `${rows.length}:${hash.toString(16).padStart(16, "0")}`;
}

export function planSplice(rows: SpliceRow[], totalBefore: number, drop: number[]): SplicePlan {
  const map = spliceIndexMap(totalBefore, drop);
  const outOfRange = rows.filter((r) => !map.has(r.episode_index));
  if (outOfRange.length) {
    const sample = outOfRange.slice(0, 5).map((r) => `${r.table}:${r.episode_index}`);
    throw new Error(
      `${outOfRange.length} row(s) reference episodes outside 0..${totalBefore - 1} (${sample}); ` +
        "is total_before right, or was this splice already applied?"
    );
  }
  const patches: SplicePlan["patches"] = [];
  const deletes: SpliceRow[] = [];
  let unchanged = 0;
  for (const row of rows) {
    const next = map.get(row.episode_index)!;
    if (next === null) deletes.push(row);
    else if (next !== row.episode_index) patches.push({ ...row, new_episode_index: next });
    else unchanged += 1;
  }
  return { patches, deletes, unchanged, fingerprint: rowsFingerprint(rows) };
}

/** Per-table patch/delete counts for the operator-facing summary. */
export function summarizePlan(plan: SplicePlan): Record<string, { patched: number; deleted: number }> {
  const out: Record<string, { patched: number; deleted: number }> = {};
  const bump = (table: string, key: "patched" | "deleted") => {
    out[table] ??= { patched: 0, deleted: 0 };
    out[table][key] += 1;
  };
  for (const row of plan.patches) bump(row.table, "patched");
  for (const row of plan.deletes) bump(row.table, "deleted");
  return out;
}
