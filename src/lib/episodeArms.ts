/**
 * Per-episode arm labels for the outcome-review queue filter.
 *
 * Collection repos carry arms in their ledger JSONLs; eval repos carry none,
 * so their arms come from `results.json` (`rollouts[].policy_id` joined to
 * `summary[].name`, the arm names the eval wrote).
 */

export type EpisodeArmSource = "ledger" | "results";

export interface EpisodeArms {
  source: EpisodeArmSource;
  arms: Map<number, string>;
}

/** Arm label per episode from an eval `results.json` payload. Throws on a malformed payload. */
export function armsFromResults(payload: unknown): Map<number, string> {
  const root = payload as { summary?: unknown; rollouts?: unknown };
  if (!Array.isArray(root.summary) || !Array.isArray(root.rollouts)) {
    throw new Error("results.json: expected `summary` and `rollouts` arrays");
  }
  const names = new Map<number, string>();
  for (const row of root.summary as Record<string, unknown>[]) {
    if (row.policy_id == null || row.name == null) {
      throw new Error("results.json: summary row missing policy_id or name");
    }
    const policyId = Number(row.policy_id);
    if (names.has(policyId)) {
      throw new Error(`results.json: duplicate summary policy_id ${policyId}`);
    }
    names.set(policyId, String(row.name));
  }
  const arms = new Map<number, string>();
  for (const rollout of root.rollouts as Record<string, unknown>[]) {
    if (rollout.episode_index == null || rollout.policy_id == null) {
      throw new Error("results.json: rollout missing episode_index or policy_id");
    }
    const episodeIndex = Number(rollout.episode_index);
    const name = names.get(Number(rollout.policy_id));
    if (name === undefined) {
      throw new Error(
        `results.json: episode ${episodeIndex} has policy_id ${rollout.policy_id} with no summary row`
      );
    }
    if (arms.has(episodeIndex)) {
      throw new Error(`results.json: duplicate rollout episode_index ${episodeIndex}`);
    }
    arms.set(episodeIndex, name);
  }
  return arms;
}

/** `?arm=` value -> selected arms; null = no arm filter. Comma-separated selects several. */
export function parseArmFilter(value: string): string[] | null {
  if (value === "all") return null;
  const selected = [...new Set(value.split(",").map((arm) => arm.trim()).filter(Boolean))];
  return selected.length > 0 ? selected : null;
}

/** Selected arms that this dataset does not have (a stale or mistyped `?arm=`). */
export function unknownArms(selected: string[], options: string[]): string[] {
  const known = new Set(options);
  return selected.filter((arm) => !known.has(arm));
}
