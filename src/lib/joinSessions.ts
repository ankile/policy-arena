// Pure helpers for the "join sessions" view: N eval sessions picked by the
// user, aligned round-by-round on round_index so every round's rollouts from
// every session can be shown side by side. No React, no network — unit-tested
// in joinSessions.test.ts.

export interface JoinRoundResult {
  policy_id: string;
  policyName: string;
  success: boolean;
  episode_index: number;
}

export interface JoinSide {
  sessionId: string;
  rounds: Array<{ index: number; results: JoinRoundResult[] }>;
}

export interface JoinedRound {
  index: number;
  // One entry per side, in the order the sides were given. `null` when that
  // session has no round with this index (sessions may differ in length).
  perSide: Array<JoinRoundResult[] | null>;
}

// Session letters shown on chips/badges: A, B, C, ...
export function sessionLetter(position: number): string {
  if (position < 0 || position >= 26) {
    throw new Error(`Session position ${position} out of letter range`);
  }
  return String.fromCharCode(65 + position);
}

/**
 * Align rounds across sides by round index: the union of every side's round
 * indices, ascending, with a per-side slot that is null where a side lacks
 * that round.
 */
export function alignRounds(sides: JoinSide[]): JoinedRound[] {
  const indices = new Set<number>();
  const bySide = sides.map((side) => {
    const map = new Map<number, JoinRoundResult[]>();
    for (const round of side.rounds) {
      if (map.has(round.index)) {
        throw new Error(
          `Session ${side.sessionId} has duplicate round index ${round.index}`,
        );
      }
      map.set(round.index, round.results);
      indices.add(round.index);
    }
    return map;
  });
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      perSide: bySide.map((map) => map.get(index) ?? null),
    }));
}

export interface PolicySuccessSummary {
  policy_id: string;
  policyName: string;
  successes: number;
  rounds: number;
}

/** Per-policy success counts within one side, in first-seen policy order. */
export function sideSuccessSummary(side: JoinSide): PolicySuccessSummary[] {
  const byPolicy = new Map<string, PolicySuccessSummary>();
  for (const round of side.rounds) {
    for (const result of round.results) {
      let entry = byPolicy.get(result.policy_id);
      if (!entry) {
        entry = {
          policy_id: result.policy_id,
          policyName: result.policyName,
          successes: 0,
          rounds: 0,
        };
        byPolicy.set(result.policy_id, entry);
      }
      entry.rounds += 1;
      if (result.success) entry.successes += 1;
    }
  }
  return [...byPolicy.values()];
}

/** Human summary of how the sides overlap, e.g. "40 aligned · 10 A-only". */
export function alignmentSummary(rounds: JoinedRound[]): string {
  const sideCount = rounds[0]?.perSide.length ?? 0;
  let aligned = 0;
  const onlyCounts = new Array<number>(sideCount).fill(0);
  for (const round of rounds) {
    const present = round.perSide
      .map((results, i) => (results ? i : -1))
      .filter((i) => i >= 0);
    if (present.length === sideCount) {
      aligned += 1;
    } else if (present.length === 1) {
      onlyCounts[present[0]] += 1;
    }
  }
  const parts = [`${aligned} aligned`];
  onlyCounts.forEach((count, i) => {
    if (count > 0) parts.push(`${count} ${sessionLetter(i)}-only`);
  });
  return parts.join(" · ");
}

// The `join` URL param is a comma-separated, order-preserving list of
// session ids; order defines the A/B/C letters.
export function parseJoinParam(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  const ids = raw.split(",").filter((id) => id.length > 0);
  return [...new Set(ids)];
}

export function formatJoinParam(ids: string[]): string | null {
  return ids.length === 0 ? null : ids.join(",");
}

export function toggleJoinId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
