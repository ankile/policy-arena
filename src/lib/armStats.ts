// Per-arm aggregate stats over a set of rounds: success count, mean graded
// score inputs, and the pairwise W/D/L record against every other arm in the
// same round. An "arm" is keyed by `policy_id`; the joined-sessions view keys
// arms by session letter + policy so the same policy in two sessions stays
// two arms. Pure, unit-tested in armStats.test.ts.

import { episodeScore } from "./outcomeScore";

export interface Arm {
  /** Matches `policy_id` on the round results. */
  key: string;
  name: string;
  /** Optional provenance badge, e.g. the session letter in the joined view. */
  badge?: string;
}

export interface ArmResult {
  policy_id: string;
  policyName: string;
  success: boolean;
  episode_index: number;
  num_subtask_marks: number | null;
}

export interface ArmRound {
  index: number;
  results: ArmResult[];
}

export interface ArmRoundResult {
  policy_id: string;
  success: boolean;
  num_subtask_marks: number | null;
}

export interface ArmStats {
  /** Rounds in which this arm has a result. */
  n: number;
  successes: number;
  wins: number;
  draws: number;
  losses: number;
  /** Graded rounds (success + marks) for the 0..N+1 score. */
  graded: Array<{ success: boolean; marks: number | null }>;
  /** Pairwise W/D/L on the graded score (only filled when maxMarks > 0). */
  scoreWins: number;
  scoreDraws: number;
  scoreLosses: number;
}

export function armStats(
  armKeys: string[],
  rounds: Array<{ results: ArmRoundResult[] }>,
  maxMarks: number,
): Map<string, ArmStats> {
  const stats = new Map<string, ArmStats>();
  for (const key of armKeys) {
    stats.set(key, {
      n: 0,
      successes: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      graded: [],
      scoreWins: 0,
      scoreDraws: 0,
      scoreLosses: 0,
    });
  }
  for (const round of rounds) {
    const results = round.results.filter((r) => stats.has(r.policy_id));
    for (const result of results) {
      const s = stats.get(result.policy_id)!;
      s.n += 1;
      if (result.success) s.successes += 1;
      s.graded.push({ success: result.success, marks: result.num_subtask_marks });
    }
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i];
        const b = results[j];
        const sa = stats.get(a.policy_id)!;
        const sb = stats.get(b.policy_id)!;
        if (a.success && !b.success) {
          sa.wins += 1;
          sb.losses += 1;
        } else if (!a.success && b.success) {
          sa.losses += 1;
          sb.wins += 1;
        } else {
          sa.draws += 1;
          sb.draws += 1;
        }
        if (maxMarks > 0) {
          const scoreA = episodeScore(a.success, a.num_subtask_marks);
          const scoreB = episodeScore(b.success, b.num_subtask_marks);
          if (scoreA > scoreB) {
            sa.scoreWins += 1;
            sb.scoreLosses += 1;
          } else if (scoreA < scoreB) {
            sa.scoreLosses += 1;
            sb.scoreWins += 1;
          } else {
            sa.scoreDraws += 1;
            sb.scoreDraws += 1;
          }
        }
      }
    }
  }
  return stats;
}

/**
 * Arms in the given policy order, plus any policy that only shows up in a
 * round result (defensive against a session whose policy list is stale).
 */
export function armsFromPolicies(
  policies: Array<{ _id: string; name: string }>,
  rounds: ArmRound[],
): Arm[] {
  const arms = policies.map((p) => ({ key: p._id, name: p.name }));
  const known = new Set(arms.map((a) => a.key));
  for (const round of rounds) {
    for (const result of round.results) {
      if (!known.has(result.policy_id)) {
        known.add(result.policy_id);
        arms.push({ key: result.policy_id, name: result.policyName });
      }
    }
  }
  return arms;
}
