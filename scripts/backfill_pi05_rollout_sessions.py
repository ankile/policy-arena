#!/usr/bin/env python3
"""
Create rollout eval sessions for pi0.5 models from their rollout datasets.
This registers the pi0.5 policies on the leaderboard with success rate data.

Usage:
    PYTHONPATH=. .venv/bin/python -m scripts.backfill_pi05_rollout_sessions
    (run from the python/ directory)
"""

import io

import requests
import pyarrow.parquet as pq

from policy_arena.client import PolicyArenaClient
from policy_arena.types import PolicyInput

ARENA_URL = "https://grandiose-rook-292.convex.cloud"

# Pi0.5 rollout datasets and their corresponding model info
# model_id uses @environment suffix to disambiguate same model across tasks
PI05_DATASETS = [
    {
        "repo_id": "ankile/rollout-pi05-zeroshot-pick-cube-2026-02-19",
        "model_id": "hf://ankile/openpi-pi05-droid-pretrained@franka_pick_cube",
        "model_url": "https://huggingface.co/ankile/openpi-pi05-droid-pretrained",
        "policy_name": "pi05-droid-pretrained (zeroshot)",
        "environment": "franka_pick_cube",
    },
    {
        "repo_id": "ankile/rollout-pi05-zeroshot-stack-two-blocks-2026-02-19",
        "model_id": "hf://ankile/openpi-pi05-droid-pretrained@franka_stack_two_blocks",
        "model_url": "https://huggingface.co/ankile/openpi-pi05-droid-pretrained",
        "policy_name": "pi05-droid-pretrained (zeroshot)",
        "environment": "franka_stack_two_blocks",
    },
    {
        "repo_id": "ankile/rollout-pi05-zeroshot-insert-marker-2026-02-19",
        "model_id": "hf://ankile/openpi-pi05-droid-pretrained@insert_marker_single",
        "model_url": "https://huggingface.co/ankile/openpi-pi05-droid-pretrained",
        "policy_name": "pi05-droid-pretrained (zeroshot)",
        "environment": "insert_marker_single",
    },
    {
        "repo_id": "ankile/rollout-pi05-finetuned-hf-insert-marker-2026-02-20",
        "model_id": "hf://ankile/openpi-pi05-franka-insert-marker-v2-ft",
        "model_url": "https://huggingface.co/ankile/openpi-pi05-franka-insert-marker-v2-ft",
        "policy_name": "pi05-insert-marker-v2-ft",
        "environment": "insert_marker_single",
    },
]


def fetch_episodes_from_parquet(repo_id: str) -> list[tuple[int, bool, int | None]]:
    """Fetch per-episode success and frame counts from the parquet metadata.

    Uses stats/success/max as the success indicator (1.0 = success, 0.0 = failure).
    Returns list of (episode_index, success, num_frames) sorted by episode_index.
    """
    parquet_url = f"https://huggingface.co/datasets/{repo_id}/resolve/main/meta/episodes/chunk-000/file-000.parquet"
    resp = requests.get(parquet_url)
    resp.raise_for_status()
    table = pq.read_table(io.BytesIO(resp.content))
    df = table.to_pandas()

    result = []
    for _, row in df.iterrows():
        ep_idx = int(row["episode_index"])
        num_frames = int(row["length"])
        # stats/success/max is a 1-element array; max >= 1 means success
        success = int(row["stats/success/max"].max()) >= 1
        result.append((ep_idx, success, num_frames))

    return sorted(result, key=lambda x: x[0])


def main():
    arena = PolicyArenaClient(ARENA_URL)

    for ds_info in PI05_DATASETS:
        repo_id = ds_info["repo_id"]
        print(f"\nProcessing: {repo_id}")
        print(f"  Model ID: {ds_info['model_id']}")
        print(f"  Environment: {ds_info['environment']}")

        episodes = fetch_episodes_from_parquet(repo_id)
        if not episodes:
            print("  Skipping (no episodes found)")
            continue

        num_success = sum(1 for _, s, _ in episodes if s)
        print(f"  Episodes: {len(episodes)} ({num_success} success, {len(episodes) - num_success} failure)")

        policy = PolicyInput(
            name=ds_info["policy_name"],
            model_id=ds_info["model_id"],
            model_url=ds_info["model_url"],
            environment=ds_info["environment"],
        )

        session_id = arena.submit_rollout_session(
            dataset_repo=repo_id,
            policy=policy,
            episodes=episodes,
            notes=f"Backfilled pi0.5 rollout from {repo_id}",
        )
        print(f"  Created session: {session_id}")

    print("\nDone.")


if __name__ == "__main__":
    main()
