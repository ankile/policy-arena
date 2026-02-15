"""
Resubmit eval sessions to Policy Arena Convex backend.

Session 1: ankile/blind-eval-pick-cube-2026-02-14
  - 2 policies, 10 rounds (after dedup of warm-up retries in rounds 1-2).
  - Convert 1-indexed round_ids to 0-indexed round_index.

Session 2: ankile/blind-eval-pick-cube-2026-02-14-round2
  - 2 policies, 10 rounds, no dedup needed.

Session 3: ankile/blind-eval-dagger-progression-2026-02-14-r1
  - 3 policies, 12 complete rounds (round 13 incomplete, excluded).
"""

import os

import datasets
from policy_arena import PolicyArenaClient, PolicyInput, RoundInput, RoundResultInput


CONVEX_URL = os.environ.get("CONVEX_URL", "https://grandiose-rook-292.convex.cloud")
ENVIRONMENT = "franka_pick_cube"

# Per-session artifact mappings: policy_id -> (wandb_artifact, name)
SESSION1_POLICY_MAP = {
    0: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_20000:v0",
        "dp-dagger-pick-cube-v3-with-auto (jqxhpam8)",
    ),
    1: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_20000:v1",
        "dp-dagger-pick-cube-v3-aggressive-aug (1p5lsm3q)",
    ),
}

SESSION2_POLICY_MAP = SESSION1_POLICY_MAP

SESSION3_POLICY_MAP = {
    0: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v3",
        "dp-bc-pick-cube-v2 (1hsp1oul)",
    ),
    1: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v2",
        "dp-dagger-pick-cube-v2-with-auto (qj1yepvc)",
    ),
    2: (
        "self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_20000:v0",
        "dp-dagger-pick-cube-v3-with-auto (jqxhpam8)",
    ),
}

# Raw episode data from HF (frame_index=0 rows).
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

SESSION2_EPISODES = [
    (0, 1, 1, 1),
    (1, 1, 0, 1),
    (2, 1, 1, 2),
    (3, 0, 0, 2),
    (4, 1, 1, 3),
    (5, 0, 0, 3),
    (6, 1, 0, 4),
    (7, 1, 1, 4),
    (8, 0, 0, 5),
    (9, 0, 1, 5),
    (10, 1, 0, 6),
    (11, 0, 1, 6),
    (12, 0, 1, 7),
    (13, 0, 0, 7),
    (14, 1, 0, 8),
    (15, 1, 1, 8),
    (16, 0, 1, 9),
    (17, 0, 0, 9),
    (18, 0, 0, 10),
    (19, 1, 1, 10),
]

SESSION3_EPISODES = [
    (0, 1, 2, 1),
    (1, 0, 0, 1),
    (2, 1, 1, 1),
    (3, 0, 0, 2),
    (4, 1, 1, 2),
    (5, 1, 2, 2),
    (6, 0, 0, 3),
    (7, 1, 1, 3),
    (8, 0, 2, 3),
    (9, 0, 2, 4),
    (10, 0, 0, 4),
    (11, 0, 1, 4),
    (12, 1, 2, 5),
    (13, 0, 0, 5),
    (14, 0, 1, 5),
    (15, 1, 2, 6),
    (16, 0, 1, 6),
    (17, 0, 0, 6),
    (18, 1, 2, 7),
    (19, 0, 1, 7),
    (20, 1, 0, 7),
    (21, 0, 0, 8),
    (22, 1, 2, 8),
    (23, 1, 1, 8),
    (24, 0, 0, 9),
    (25, 1, 2, 9),
    (26, 0, 1, 9),
    (27, 0, 0, 10),
    (28, 0, 1, 10),
    (29, 0, 2, 10),
    (30, 0, 2, 11),
    (31, 0, 1, 11),
    (32, 0, 0, 11),
    (33, 0, 0, 12),
    (34, 0, 1, 12),
    (35, 0, 2, 12),
    # Round 13 incomplete (only 2 of 3 policies), excluded
]


def fetch_num_frames(dataset_repo: str) -> dict[int, int]:
    """
    Fetch num_frames per episode_index from a HF LeRobot dataset.
    Returns {episode_index: num_frames}.
    """
    ds = datasets.load_dataset(dataset_repo, split="train")
    episode_frames: dict[int, int] = {}
    for row in ds:
        ep_idx = row["episode_index"]
        frame_idx = row["frame_index"]
        if ep_idx not in episode_frames or frame_idx + 1 > episode_frames[ep_idx]:
            episode_frames[ep_idx] = frame_idx + 1
    return episode_frames


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


def build_rounds(
    episodes: list[tuple[int, int, int, int]],
    policy_map: dict[int, tuple[str, str]],
    num_frames_map: dict[int, int],
    max_round: int | None = None,
) -> list[RoundInput]:
    best = deduplicate_episodes(episodes)
    round_ids = sorted({k[0] for k in best})
    if max_round is not None:
        round_ids = [r for r in round_ids if r <= max_round]

    rounds = []
    for round_id in round_ids:
        results = []
        for policy_id in sorted(policy_map.keys()):
            ep_index, success, pid, rid = best[(round_id, policy_id)]
            assert pid == policy_id
            assert rid == round_id
            artifact = policy_map[policy_id][0]
            results.append(
                RoundResultInput(
                    wandb_artifact=artifact,
                    success=bool(success),
                    episode_index=ep_index,
                    num_frames=num_frames_map.get(ep_index),
                )
            )
        rounds.append(RoundInput(round_index=round_id - 1, results=results))

    return rounds


def build_policies(policy_map: dict[int, tuple[str, str]]) -> list[PolicyInput]:
    return [
        PolicyInput(
            name=name,
            wandb_artifact=artifact,
            environment=ENVIRONMENT,
        )
        for artifact, name in policy_map.values()
    ]


def submit_session(
    client: PolicyArenaClient,
    label: str,
    dataset_repo: str,
    episodes: list[tuple[int, int, int, int]],
    policy_map: dict[int, tuple[str, str]],
    notes: str,
    max_round: int | None = None,
):
    print(f"=== {label}: {dataset_repo} ===")
    print("  Fetching num_frames from HF...")
    num_frames_map = fetch_num_frames(dataset_repo)
    print(f"  Got frame counts for {len(num_frames_map)} episodes")

    policies = build_policies(policy_map)
    rounds = build_rounds(episodes, policy_map, num_frames_map, max_round=max_round)
    print(f"  Policies: {len(policies)}")
    print(f"  Rounds: {len(rounds)}")
    for r in rounds:
        print(
            f"    Round {r.round_index}: "
            f"{[(res.wandb_artifact.split(':')[-1], res.success, res.episode_index, res.num_frames) for res in r.results]}"
        )

    session_id = client.submit_eval_session(
        dataset_repo=dataset_repo,
        policies=policies,
        rounds=rounds,
        notes=notes,
    )
    print(f"  Submitted! Session ID: {session_id}")


def main():
    client = PolicyArenaClient(CONVEX_URL)

    submit_session(
        client,
        label="Session 1",
        dataset_repo="ankile/blind-eval-pick-cube-2026-02-14",
        episodes=SESSION1_EPISODES,
        policy_map=SESSION1_POLICY_MAP,
        notes="Resubmitted from HF dataset. Rounds 1-2 deduplicated (warm-up retries removed).",
    )

    print()
    submit_session(
        client,
        label="Session 2",
        dataset_repo="ankile/blind-eval-pick-cube-2026-02-14-round2",
        episodes=SESSION2_EPISODES,
        policy_map=SESSION2_POLICY_MAP,
        notes="Resubmitted from HF dataset.",
    )

    print()
    submit_session(
        client,
        label="Session 3",
        dataset_repo="ankile/blind-eval-dagger-progression-2026-02-14-r1",
        episodes=SESSION3_EPISODES,
        policy_map=SESSION3_POLICY_MAP,
        notes="Resubmitted from HF dataset. Round 13 excluded (incomplete).",
        max_round=12,
    )


if __name__ == "__main__":
    main()
