#!/usr/bin/env python3
"""
Backfill model_url / training_url for policies.

The leaderboard stores a `training_url` (the wandb training run) that the policy
detail view renders as a "Training Run" row. We resolve it differently per id
scheme:

  - wandb://entity/project/artifact:version
        The artifact's producing run via the wandb API (`artifact.logged_by()`).
        This is authoritative and works no matter where (or whether) the run id
        is embedded in the artifact name.

  - hf://owner/repo[@variant]
        Read the HuggingFace model card: prefer an embedded
        `| W&B run | [link](...) |` row, otherwise resolve by the OpenPI train
        command's `--project-name` / `--exp-name`. Also sets model_url to the HF
        model page so the Model ID is clickable.

Existing model_url / training_url values are never overwritten.

Usage (dry run):
    PYTHONPATH=python uv run --project python --with wandb \
        python -m scripts.backfill_wandb_links

Apply:
    PYTHONPATH=python uv run --project python --with wandb \
        python -m scripts.backfill_wandb_links --apply
"""

import re
import sys
import urllib.request

import wandb

from policy_arena.client import PolicyArenaClient

ARENA_URL = "https://grandiose-rook-292.convex.cloud"
WANDB_ENTITY = "self-improving"


# ---------------------------------------------------------------- wandb:// ----
def resolve_artifact_run(api: wandb.Api, model_id: str) -> str | None:
    """`wandb://entity/project/artifact:version` -> producing run URL (or None)."""
    path = model_id[len("wandb://"):]
    try:
        artifact = api.artifact(path)  # type auto-detected
        run = artifact.logged_by()
    except Exception as e:  # missing/deleted artifact, test entities, etc.
        print(f"    ! artifact lookup failed: {type(e).__name__}: {e}")
        return None
    if run is None:
        print("    ! artifact has no producing run")
        return None
    return run.url


# ------------------------------------------------------------------- hf:// ----
def hf_repo_from_model_id(model_id: str) -> str:
    """`hf://owner/repo@variant` -> `owner/repo`."""
    return model_id[len("hf://"):].split("@", 1)[0]


def fetch_model_card(repo_id: str) -> str:
    url = f"https://huggingface.co/{repo_id}/raw/main/README.md"
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def find_wandb_url(card: str) -> str | None:
    """Newer cards embed the run: `| W&B run | [link](https://wandb.ai/.../runs/ID) |`."""
    m = re.search(r"https://wandb\.ai/[\w.\-/]+/runs/[\w]+", card)
    return m.group(0) if m else None


def parse_train_args(card: str) -> tuple[str | None, str | None]:
    """Pull --project-name / --exp-name from the OpenPI train command in the card."""
    project = re.search(r"--project-name[=\s]+(\S+)", card)
    exp = re.search(r"--exp-name[=\s]+(\S+)", card)
    return (
        project.group(1) if project else None,
        exp.group(1) if exp else None,
    )


def resolve_wandb_run_by_name(api: wandb.Api, project: str, exp_name: str) -> str | None:
    """Find the wandb run named `exp_name` in `entity/project`; return its URL."""
    runs = list(api.runs(f"{WANDB_ENTITY}/{project}"))
    exact = [r for r in runs if r.name == exp_name]
    if not exact:
        print(f"    ! no run named {exp_name!r} in {WANDB_ENTITY}/{project} "
              f"({len(runs)} runs total)")
        return None
    if len(exact) > 1:
        exact.sort(key=lambda r: r.created_at, reverse=True)
        print(f"    ! {len(exact)} runs named {exp_name!r}; "
              f"picking newest ({exact[0].id} @ {exact[0].created_at})")
    return exact[0].url


def hf_training_url(api: wandb.Api, repo_id: str) -> str | None:
    card = fetch_model_card(repo_id)
    direct = find_wandb_url(card)
    if direct:
        print(f"    wandb (from card): {direct}")
        return direct
    project, exp_name = parse_train_args(card)
    if project and exp_name:
        url = resolve_wandb_run_by_name(api, project, exp_name)
        if url:
            print(f"    wandb (resolved {project}/{exp_name}): {url}")
        return url
    print(f"    no W&B link or train command in card — pretrained/base, no training run")
    return None


# -------------------------------------------------------------------- main ----
def main() -> None:
    apply = "--apply" in sys.argv
    arena = PolicyArenaClient(ARENA_URL)
    api = wandb.Api()

    policies = arena.client.query("policies:leaderboard", {})
    print(f"{len(policies)} policies ({'APPLY' if apply else 'DRY RUN'})\n")

    updated = 0
    for p in policies:
        model_id = p["model_id"]
        patch: dict[str, str] = {}

        if not p.get("training_url"):
            if model_id.startswith("wandb://"):
                url = resolve_artifact_run(api, model_id)
                if url:
                    print(f"• {model_id}\n    wandb: {url}")
                    patch["training_url"] = url
            elif model_id.startswith("hf://"):
                repo_id = hf_repo_from_model_id(model_id)
                print(f"• {model_id}")
                url = hf_training_url(api, repo_id)
                if url:
                    patch["training_url"] = url
                if not p.get("model_url"):
                    patch["model_url"] = f"https://huggingface.co/{repo_id}"

        if not patch:
            continue

        print(f"    patch: {patch}")
        if apply:
            arena.set_policy_links(model_id=model_id, **patch)
            print("    ✓ applied")
        updated += 1
        print()

    print(f"\n{updated} policies {'updated' if apply else 'would be updated'}")


if __name__ == "__main__":
    main()
