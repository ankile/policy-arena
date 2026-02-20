#!/usr/bin/env python3
"""
One-off script to backfill dataset stats (success/failure counts, frame sources,
autonomous successes) for all registered datasets.

Fetches episode metadata from HuggingFace Datasets server and updates Convex.

Usage:
    python -m scripts.backfill_stats
"""

import requests
from convex import ConvexClient

ARENA_URL = "https://grandiose-rook-292.convex.cloud"
DATASETS_SERVER = "https://datasets-server.huggingface.co"
FPS = 15


def fetch_episode_stats(repo_id: str) -> dict:
    """Fetch success/failure counts from HF Datasets server."""
    url = f"{DATASETS_SERVER}/filter?dataset={repo_id}&config=default&split=train&where=frame_index=0&length=100"
    resp = requests.get(url)
    resp.raise_for_status()
    data = resp.json()

    successes = 0
    failures = 0
    for row_entry in data["rows"]:
        row = row_entry["row"]
        if row.get("success") == 1:
            successes += 1
        else:
            failures += 1

    return {"num_success": successes, "num_failure": failures}


def fetch_source_stats(repo_id: str) -> dict | None:
    """Fetch human/policy frame counts and autonomous success info.

    Returns None if the dataset doesn't have a 'source' column.
    """
    base = f"{DATASETS_SERVER}/filter?dataset={repo_id}&config=default&split=train"

    policy_resp = requests.get(f"{base}&where=source=0&length=1")
    human_resp = requests.get(f"{base}&where=source=1&length=1")

    if policy_resp.status_code != 200 or human_resp.status_code != 200:
        return None

    policy_data = policy_resp.json()
    human_data = human_resp.json()

    policy_frames = policy_data.get("num_rows_total")
    human_frames = human_data.get("num_rows_total")
    if policy_frames is None or human_frames is None:
        return None

    # Paginate through human-source rows to collect unique episode indices
    episodes_with_human = set()
    if human_frames > 0:
        offset = 0
        page_size = 100
        while offset < human_frames:
            page_resp = requests.get(
                f"{base}&where=source=1&offset={offset}&length={page_size}"
            )
            if page_resp.status_code != 200:
                break
            page_data = page_resp.json()
            for row_entry in page_data["rows"]:
                episodes_with_human.add(row_entry["row"]["episode_index"])
            offset += page_size

    return {
        "num_human_frames": human_frames,
        "num_policy_frames": policy_frames,
        "episodes_with_human": episodes_with_human,
    }


def fetch_episode_count_and_duration(repo_id: str) -> dict:
    """Fetch total episode count and duration from frame_index=0 rows."""
    url = f"{DATASETS_SERVER}/filter?dataset={repo_id}&config=default&split=train&where=frame_index=0&length=100"
    resp = requests.get(url)
    resp.raise_for_status()
    data = resp.json()

    num_episodes = len(data["rows"])
    # Get total frame count from num_rows_total (all frames)
    total_rows = data.get("num_rows_total", 0)
    total_duration = total_rows / FPS

    return {"num_episodes": num_episodes, "total_duration_seconds": total_duration}


def main():
    client = ConvexClient(ARENA_URL)
    datasets = client.query("datasets:list", {})

    print(f"Found {len(datasets)} datasets to backfill.\n")

    success_count = 0
    fail_count = 0
    for ds in datasets:
        repo_id = ds["repo_id"]
        name = ds["name"]
        print(f"Processing: {name} ({repo_id})")

        try:
            # Fetch episode-level stats (success/failure)
            ep_stats = fetch_episode_stats(repo_id)
            print(f"  Episodes: {ep_stats['num_success']} success, {ep_stats['num_failure']} failed")

            # Fetch source stats (human/policy frames) - may be None
            source = fetch_source_stats(repo_id)

            # Build updateStats args
            num_episodes = ds["num_episodes"].value if ds.get("num_episodes") is not None else ep_stats["num_success"] + ep_stats["num_failure"]
            total_duration = ds.get("total_duration_seconds") or 0.0

            update_args: dict = {
                "repo_id": repo_id,
                "num_episodes": num_episodes,
                "total_duration_seconds": total_duration,
                "num_success": ep_stats["num_success"],
                "num_failure": ep_stats["num_failure"],
            }

            if source is not None:
                update_args["num_human_frames"] = source["num_human_frames"]
                update_args["num_policy_frames"] = source["num_policy_frames"]

                success_eps = get_successful_episode_indices(repo_id)
                autonomous = len(success_eps - source["episodes_with_human"])
                update_args["num_autonomous_success"] = autonomous

                print(f"  Frames: {source['num_human_frames']} human, {source['num_policy_frames']} policy")
                print(f"  Autonomous successes: {autonomous}")
            else:
                print("  No source column (teleop/rollout/eval dataset)")

            client.mutation("datasets:updateStats", update_args)
            print(f"  Updated!\n")
            success_count += 1
        except Exception as e:
            print(f"  FAILED: {e}\n")
            fail_count += 1

    print(f"Done. Backfilled {success_count} datasets, {fail_count} failed.")


def get_successful_episode_indices(repo_id: str) -> set[int]:
    """Get set of episode indices where success=1."""
    url = f"{DATASETS_SERVER}/filter?dataset={repo_id}&config=default&split=train&where=frame_index=0&length=100"
    resp = requests.get(url)
    resp.raise_for_status()
    data = resp.json()

    return {
        row_entry["row"]["episode_index"]
        for row_entry in data["rows"]
        if row_entry["row"].get("success") == 1
    }


if __name__ == "__main__":
    main()
