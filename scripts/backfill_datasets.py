#!/usr/bin/env python3
"""
One-off script to register existing datasets in the Policy Arena.
Run once after deploying the datasets table, then delete or keep as template.

Usage:
    python -m scripts.backfill_datasets
"""

from policy_arena.client import PolicyArenaClient
from policy_arena.types import DatasetInput

ARENA_URL = "https://grandiose-rook-292.convex.cloud"

DATASETS = [
    # --- Teleop (3) ---
    DatasetInput(
        repo_id="ankile/franka-pick-cube-v2",
        name="franka-pick-cube-v2",
        task="franka_pick_cube",
        source_type="teleop",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/franka-nut-assembly-square-v2",
        name="franka-nut-assembly-square-v2",
        task="franka_nut_assembly_square",
        source_type="teleop",
        environment="franka_nut_assembly_square",
    ),
    DatasetInput(
        repo_id="ankile/franka-stack-two-blocks-v1",
        name="franka-stack-two-blocks-v1",
        task="franka_stack_two_blocks",
        source_type="teleop",
        environment="franka_stack_two_blocks",
    ),
    # --- Rollout (8) ---
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-12",
        name="dp-franka-pick-cube-2026-02-12",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v0",
    ),
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-13-75k-w-auto-v1",
        name="dp-franka-pick-cube-2026-02-13-75k-w-auto-v1",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_75000:v0",
    ),
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-13-25k-no-auto-v1",
        name="dp-franka-pick-cube-2026-02-13-25k-no-auto-v1",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v1",
    ),
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-13-75k-no-auto-v1",
        name="dp-franka-pick-cube-2026-02-13-75k-no-auto-v1",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_75000:v0",
    ),
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-13-25k-demos-v1",
        name="dp-franka-pick-cube-2026-02-13-25k-demos-v1",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v3",
    ),
    DatasetInput(
        repo_id="ankile/dp-franka-pick-cube-2026-02-13-75k-demos-v1",
        name="dp-franka-pick-cube-2026-02-13-75k-demos-v1",
        task="franka_pick_cube",
        source_type="rollout",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_75000:v2",
    ),
    DatasetInput(
        repo_id="ankile/rollout-dp-nut-assembly-square-v2-2026-02-15",
        name="rollout-dp-nut-assembly-square-v2-2026-02-15",
        task="franka_nut_assembly_square",
        source_type="rollout",
        environment="franka_nut_assembly_square",
        wandb_artifact="self-improving/franka-nut-assembly-square/dp-bc-nut-assembly-square-v2-hi3he6ii-final:v0",
    ),
    DatasetInput(
        repo_id="ankile/rollout-dp-stack-two-blocks-v1-2026-02-15",
        name="rollout-dp-stack-two-blocks-v1-2026-02-15",
        task="franka_stack_two_blocks",
        source_type="rollout",
        environment="franka_stack_two_blocks",
        wandb_artifact="self-improving/franka-stack-two-blocks/dp-bc-stack-two-blocks-v1-zh5uj4dr-final:v0",
    ),
    # --- DAgger (5) ---
    DatasetInput(
        repo_id="ankile/dagger-dp-franka-pick-cube-2026-02-12-v2",
        name="dagger-dp-franka-pick-cube-2026-02-12-v2",
        task="franka_pick_cube",
        source_type="dagger",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v0",
    ),
    DatasetInput(
        repo_id="ankile/dagger-dp-franka-pick-cube-2026-02-13-25k-w-auto",
        name="dagger-dp-franka-pick-cube-2026-02-13-25k-w-auto",
        task="franka_pick_cube",
        source_type="dagger",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v2",
    ),
    DatasetInput(
        repo_id="ankile/dagger-dp-franka-pick-cube-2026-02-13-25k-dagger-w-auto-v1",
        name="dagger-dp-franka-pick-cube-2026-02-13-25k-dagger-w-auto-v1",
        task="franka_pick_cube",
        source_type="dagger",
        environment="franka_pick_cube",
        wandb_artifact="self-improving/franka-pick-cube/diffusion-franka-pick-cube-v2-checkpoint_25000:v2",
    ),
    DatasetInput(
        repo_id="ankile/dagger-dp-nut-assembly-square-v2-2026-02-15",
        name="dagger-dp-nut-assembly-square-v2-2026-02-15",
        task="franka_nut_assembly_square",
        source_type="dagger",
        environment="franka_nut_assembly_square",
        wandb_artifact="self-improving/franka-nut-assembly-square/dp-bc-nut-assembly-square-v2-hi3he6ii-final:v0",
    ),
    DatasetInput(
        repo_id="ankile/dagger-dp-stack-two-blocks-v1-2026-02-15",
        name="dagger-dp-stack-two-blocks-v1-2026-02-15",
        task="franka_stack_two_blocks",
        source_type="dagger",
        environment="franka_stack_two_blocks",
        wandb_artifact="self-improving/franka-stack-two-blocks/dp-bc-stack-two-blocks-v1-zh5uj4dr-final:v0",
    ),
    # --- Eval (6) ---
    DatasetInput(
        repo_id="ankile/blind-eval-pick-cube-2026-02-13",
        name="blind-eval-pick-cube-2026-02-13",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/blind-eval-pick-cube-2026-02-14",
        name="blind-eval-pick-cube-2026-02-14",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/blind-eval-pick-cube-2026-02-14-round2",
        name="blind-eval-pick-cube-2026-02-14-round2",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/blind-eval-dagger-progression-2026-02-14-r1",
        name="blind-eval-dagger-progression-2026-02-14-r1",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/blind-eval-image-size-ablation-2026-02-14-r1",
        name="blind-eval-image-size-ablation-2026-02-14-r1",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
    DatasetInput(
        repo_id="ankile/calibrate-dp-dagger-v3-10k-2026-02-15",
        name="calibrate-dp-dagger-v3-10k-2026-02-15",
        task="franka_pick_cube",
        source_type="eval",
        environment="franka_pick_cube",
    ),
]


def main():
    arena = PolicyArenaClient(ARENA_URL)
    for ds in DATASETS:
        arena.register_dataset(ds)
        print(f"Registered: {ds.repo_id}")
    print(f"\nDone. Registered {len(DATASETS)} datasets.")


if __name__ == "__main__":
    main()
