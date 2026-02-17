"""List HuggingFace dataset repo IDs from the Policy Arena registry.

Usage:
    python -m policy_arena.get_datasets
    python -m policy_arena.get_datasets --task franka_nut_assembly_square
    python -m policy_arena.get_datasets --source teleop rollout dagger
    python -m policy_arena.get_datasets --task franka_pick_cube --source teleop dagger
"""

import argparse

from policy_arena import PolicyArenaClient

CONVEX_URL = "https://grandiose-rook-292.convex.cloud"


def main():
    parser = argparse.ArgumentParser(description="List registered HF datasets")
    parser.add_argument("--task", type=str, default=None, help="Filter by task name")
    parser.add_argument(
        "--source",
        nargs="+",
        default=None,
        help="Filter by source type(s), e.g. teleop rollout dagger",
    )
    args = parser.parse_args()

    client = PolicyArenaClient(CONVEX_URL)
    datasets = client.list_datasets(task=args.task, source_types=args.source)

    for d in datasets:
        print(d["repo_id"])


if __name__ == "__main__":
    main()
