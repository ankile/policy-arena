#!/usr/bin/env python3
"""
Create rollout eval sessions from existing rollout datasets that have
a model_id set. This populates the Eval Sessions tab and makes rollout
success rates count in the leaderboard.

NOTE: Only "rollout" datasets are included — NOT "dagger" datasets.
DAgger data involves human intervention and would skew success rates.

Usage:
    python -m scripts.backfill_rollout_sessions
"""

import requests

from policy_arena.client import PolicyArenaClient
from policy_arena.types import PolicyInput

ARENA_URL = "https://grandiose-rook-292.convex.cloud"
HF_DATASETS_SERVER = "https://datasets-server.huggingface.co"


def fetch_episode_successes(repo_id: str) -> list[tuple[int, bool, int | None]]:
    """Fetch per-episode success status from HuggingFace Datasets server.

    Returns list of (episode_index, success, num_frames) sorted by episode_index.
    """
    episodes: dict[int, dict] = {}
    offset = 0
    page_size = 100

    while True:
        url = (
            f"{HF_DATASETS_SERVER}/filter?"
            f"dataset={repo_id}&config=default&split=train"
            f"&where=frame_index=0&offset={offset}&length={page_size}"
        )
        resp = requests.get(url)
        resp.raise_for_status()
        data = resp.json()

        for item in data["rows"]:
            row = item["row"]
            ep_idx = row["episode_index"]
            episodes[ep_idx] = {
                "success": row.get("success", 0) == 1,
            }

        # Check if we've fetched all rows
        total = data.get("num_rows_total", 0)
        offset += page_size
        if offset >= total:
            break

    # Now fetch num_frames from parquet metadata
    parquet_url = f"https://huggingface.co/datasets/{repo_id}/resolve/main/meta/episodes/chunk-000/file-000.parquet"
    try:
        import pyarrow.parquet as pq
        import io

        parquet_resp = requests.get(parquet_url)
        parquet_resp.raise_for_status()
        table = pq.read_table(io.BytesIO(parquet_resp.content))
        df = table.to_pandas()
        for _, row in df.iterrows():
            ep_idx = int(row["episode_index"])
            if ep_idx in episodes:
                episodes[ep_idx]["num_frames"] = int(row["length"])
    except Exception as e:
        print(f"  Warning: could not fetch parquet metadata: {e}")

    result = []
    for ep_idx in sorted(episodes.keys()):
        ep = episodes[ep_idx]
        result.append((ep_idx, ep["success"], ep.get("num_frames")))
    return result


def main():
    arena = PolicyArenaClient(ARENA_URL)

    # Get rollout datasets that have a model_id (exclude dagger — human intervention skews success rates)
    datasets = arena.list_datasets(source_types=["rollout"])

    print(f"Found {len(datasets)} rollout datasets")

    for ds in datasets:
        model_id = ds.get("model_id")
        if not model_id:
            print(f"  Skipping {ds['repo_id']} (no model_id)")
            continue

        print(f"\nProcessing: {ds['repo_id']}")
        print(f"  Model ID: {model_id}")
        print(f"  Task: {ds['task']}")

        episodes = fetch_episode_successes(ds["repo_id"])
        if not episodes:
            print(f"  Skipping (no episodes found)")
            continue

        num_success = sum(1 for _, s, _ in episodes if s)
        print(f"  Episodes: {len(episodes)} ({num_success} success, {len(episodes) - num_success} failure)")

        # Extract policy name from model_id (last segment before :version)
        policy_name = model_id.split("/")[-1].split(":")[0]

        policy = PolicyInput(
            name=policy_name,
            model_id=model_id,
            environment=ds["environment"],
        )

        session_id = arena.submit_rollout_session(
            dataset_repo=ds["repo_id"],
            policy=policy,
            episodes=episodes,
            notes=f"Backfilled from {ds['source_type']} dataset",
        )
        print(f"  Created session: {session_id}")

    print("\nDone.")


if __name__ == "__main__":
    main()
