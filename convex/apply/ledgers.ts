/**
 * Outcome-ledger (meta/*.jsonl) validation + repair against edited frame data.
 * Port of sir/tools/outcome_editor.py validate_or_repair_ledgers.
 */

import type { OutcomeName } from "./progress";
import { dumpsSorted, loadsPy } from "./pyjson";
import type { Json } from "./pyjson";

export const DEFAULT_LEDGER_NAMES = [
  "meta/blind_dagger_ledger.jsonl",
  "meta/protocol_quota_ledger.jsonl",
  "meta/teleop_manifest_ledger.jsonl",
];

type LedgerRow = Record<string, unknown>;

function loadJsonlRows(text: string, path: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = loadsPy(line);
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`${path}: ledger row must be a JSON object`);
    }
    rows.push(row as LedgerRow);
  }
  if (rows.length === 0) throw new Error(`${path}: ledger file has no rows`);
  return rows;
}

function writeJsonlRows(rows: LedgerRow[]): string {
  // Python _write_jsonl_rows: json.dumps(row, sort_keys=True) per line.
  return rows.map((r) => dumpsSorted(r as Json) + "\n").join("");
}

/**
 * Sync ledger success/outcome fields with the post-edit parquet outcomes.
 * Returns the new text when the ledger changed, else null. Only rows for
 * `onlyEpisodes` are patched; every mismatch outside repair scope, duplicate
 * episode, or unknown episode fails loud (repair=true semantics of the
 * Python apply path — errors below are the non-repairable classes).
 */
export function repairLedger(args: {
  path: string;
  text: string;
  outcomesByEpisode: Map<number, OutcomeName>;
  onlyEpisodes: Set<number>;
}): string | null {
  const rows = loadJsonlRows(args.text, args.path);
  const errors: string[] = [];
  const seen = new Set<number>();
  let changed = false;
  for (const row of rows) {
    if (!("episode_index" in row)) {
      errors.push(`${args.path}: ledger row missing episode_index: ${JSON.stringify(row)}`);
      continue;
    }
    const epIdx = Number(row.episode_index);
    if (seen.has(epIdx)) {
      errors.push(`${args.path}: duplicate episode_index ${epIdx}`);
      continue;
    }
    seen.add(epIdx);
    if (!args.onlyEpisodes.has(epIdx)) continue;
    if (!args.outcomesByEpisode.has(epIdx)) {
      errors.push(`${args.path}: episode_index ${epIdx} not found in dataset parquet`);
      continue;
    }
    const outcome = args.outcomesByEpisode.get(epIdx)!;
    const success = outcome === "success";
    if (!("success" in row) || Boolean(row.success) !== success) {
      row.success = success;
      changed = true;
    }
    if (!("outcome" in row) || String(row.outcome) !== outcome) {
      row.outcome = outcome;
      changed = true;
    }
  }
  if (errors.length > 0) {
    throw new Error(`Ledger validation failed:\n${errors.slice(0, 20).join("\n")}`);
  }
  return changed ? writeJsonlRows(rows) : null;
}
