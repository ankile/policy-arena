"""
Resubmit eval sessions to Policy Arena Convex backend.

Session 1: ankile/blind-eval-pick-cube-2026-02-14
  - Deduplicate rounds 1 and 2 (warm-up retries) by keeping only the
    last episode per (round, policy_id) pair.
  - Convert 1-indexed round_ids to 0-indexed round_index.

Session 2: ankile/blind-eval-pick-cube-2026-02-14-round2
  - Dataset has 0 bytes on HF (push didn't complete). Skip with warning.
"""

import os

from policy_arena import PolicyArenaClient, PolicyInput, RoundInput, RoundResultInput


CONVEX_URL = os.environ.get("CONVEX_URL", "https://grandiose-rook-292.convex.cloud")

# Artifact mapping: policy_id -> (wandb_artifact, name)
POLICY_MAP = {
    0: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_20000:v0",
        "dp-dagger-pick-cube-v3-with-auto (jqxhpam8)",
    ),
    1: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_20000:v1",
        "dp-dagger-pick-cube-v3-aggressive-aug (1p5lsm3q)",
    ),
}

ENVIRONMENT = "franka_pick_cube"

# Raw episode data from HF for Session 1 (frame_index=0 rows).
# Each tuple: (episode_index, success, policy_id, round_id)
# round_id is 1-indexed as in the dataset.
SESSION1_EPISODES = [
    (0, 1, 1, 1),
    (1, 1, 0, 1),
    (2, 0, 1, 2),
    (3, 1, 0, 1),
    (4, 1, 1, 1),
    (5, 1, 0, 2),
    (6, 1, 1, 2),
    (7, 0, 1, 3),
    (8, 1, 0, 3),
    (9, 0, 0, 4),
    (10, 1, 1, 4),
    (11, 1, 0, 5),
    (12, 0, 1, 5),
    (13, 1, 0, 6),
    (14, 1, 1, 6),
    (15, 0, 1, 7),
    (16, 1, 0, 7),
    (17, 0, 0, 8),
    (18, 0, 1, 8),
    (19, 1, 0, 9),
    (20, 0, 1, 9),
    (21, 1, 1, 10),
    (22, 1, 0, 10),
]


def deduplicate_episodes(
    episodes: list[tuple[int, int, int, int]],
) -> dict[tuple[int, int], tuple[int, int, int, int]]:
    """
    For each (round_id, policy_id) pair, keep only the episode with the
    highest episode_index (last attempt). Returns a dict keyed by
    (round_id, policy_id) -> episode tuple.
    """
    best: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    for ep in episodes:
        episode_index, _success, policy_id, round_id = ep
        key = (round_id, policy_id)
        if key not in best or episode_index > best[key][0]:
            best[key] = ep
    return best


def build_session1_rounds() -> list[RoundInput]:
    best = deduplicate_episodes(SESSION1_EPISODES)

    # Verify we have exactly 2 entries per round (one per policy) for 10 rounds
    round_ids = sorted({k[0] for k in best})
    assert round_ids == list(range(1, 11)), f"Expected rounds 1-10, got {round_ids}"
    assert len(best) == 20, f"Expected 20 deduped entries, got {len(best)}"

    rounds = []
    for round_id in round_ids:
        results = []
        for policy_id in sorted(POLICY_MAP.keys()):
            ep_index, success, pid, rid = best[(round_id, policy_id)]
            assert pid == policy_id
            assert rid == round_id
            artifact = POLICY_MAP[policy_id][0]
            results.append(
                RoundResultInput(
                    wandb_artifact=artifact,
                    success=bool(success),
                    episode_index=ep_index,
                )
            )
        # Convert 1-indexed round_id to 0-indexed round_index
        rounds.append(RoundInput(round_index=round_id - 1, results=results))

    return rounds


def build_policies() -> list[PolicyInput]:
    return [
        PolicyInput(
            name=name,
            wandb_artifact=artifact,
            environment=ENVIRONMENT,
        )
        for artifact, name in POLICY_MAP.values()
    ]


def main():
    client = PolicyArenaClient(CONVEX_URL)
    policies = build_policies()

    # --- Session 1 ---
    print("=== Session 1: ankile/blind-eval-pick-cube-2026-02-14 ===")
    rounds = build_session1_rounds()
    print(f"  Policies: {len(policies)}")
    print(f"  Rounds: {len(rounds)}")
    for r in rounds:
        print(f"    Round {r.round_index}: {[(res.wandb_artifact.split(':')[-1], res.success, res.episode_index) for res in r.results]}")

    session_id = client.submit_eval_session(
        dataset_repo="ankile/blind-eval-pick-cube-2026-02-14",
        policies=policies,
        rounds=rounds,
        notes="Resubmitted from HF dataset. Rounds 1-2 deduplicated (warm-up retries removed).",
    )
    print(f"  Submitted! Session ID: {session_id}")

    # --- Session 2 ---
    print()
    print("=== Session 2: ankile/blind-eval-pick-cube-2026-02-14-round2 ===")
    print("  WARNING: Dataset has 0 bytes on HuggingFace (push didn't complete).")
    print("  Cannot reconstruct episode data. Skipping.")


if __name__ == "__main__":
    main()
