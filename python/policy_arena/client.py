import json
import os
import random
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from convex import ConvexClient, convex_to_json, json_to_convex

from policy_arena.types import DatasetInput, PolicyInput, RoundInput, RoundResultInput


class PolicyArenaAPIError(RuntimeError):
    """An authenticated Policy Arena write request failed."""


class PolicyArenaClient:
    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        api_url: str | None = None,
        timeout_seconds: float = 30.0,
    ):
        self.client = ConvexClient(url)
        self.api_key = api_key or os.environ.get("POLICY_ARENA_API_KEY")
        self.api_url = api_url or self._default_api_url(url)
        self.timeout_seconds = timeout_seconds

    @staticmethod
    def _default_api_url(url: str) -> str:
        suffix = ".convex.cloud"
        if not url.endswith(suffix):
            raise ValueError(
                "api_url is required when the Convex URL does not end in .convex.cloud"
            )
        return f"{url.removesuffix(suffix)}.convex.site/api/v1"

    def _write(
        self,
        path: str,
        args: dict,
        idempotency_key: str | None = None,
    ):
        if self.api_key is None:
            raise PolicyArenaAPIError(
                "POLICY_ARENA_API_KEY is required for Policy Arena writes"
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key

        request = Request(
            f"{self.api_url}/{path}",
            data=json.dumps(convex_to_json(args)).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read())
        except HTTPError as error:
            payload = json.loads(error.read())
            raise PolicyArenaAPIError(
                f"Policy Arena write failed with HTTP {error.code}: {payload['error']}"
            ) from error

        if payload["ok"] is not True:
            raise PolicyArenaAPIError(payload["error"])
        return json_to_convex(payload["value"])

    def submit_eval_session(
        self,
        dataset_repo: str,
        policies: list[PolicyInput],
        rounds: list[RoundInput],
        notes: str | None = None,
        session_mode: str | None = None,
        idempotency_key: str | None = None,
    ) -> str:
        """Submit evaluation results. Policies are auto-registered."""
        args = {
            "dataset_repo": dataset_repo,
            "policies": [p.to_dict() for p in policies],
            "rounds": [r.to_dict() for r in rounds],
        }
        if notes is not None:
            args["notes"] = notes
        if session_mode is not None:
            args["session_mode"] = session_mode
        return self._write(
            "eval-sessions/submit",
            args,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def submit_rollout_session(
        self,
        dataset_repo: str,
        policy: PolicyInput,
        episodes: list[tuple[int, bool, int | None]],
        notes: str | None = None,
        idempotency_key: str | None = None,
    ) -> str:
        """Submit a rollout session (single policy, no ELO changes).

        Args:
            dataset_repo: HuggingFace dataset repo ID.
            policy: The policy that was rolled out.
            episodes: List of (episode_index, success, num_frames) tuples.
            notes: Optional session notes.
        """
        rounds = [
            RoundInput(
                round_index=i,
                results=[
                    RoundResultInput(
                        model_id=policy.model_id,
                        success=success,
                        episode_index=episode_index,
                        num_frames=num_frames,
                    )
                ],
            )
            for i, (episode_index, success, num_frames) in enumerate(episodes)
        ]
        return self.submit_eval_session(
            dataset_repo=dataset_repo,
            policies=[policy],
            rounds=rounds,
            notes=notes,
            session_mode="rollout",
            idempotency_key=idempotency_key,
        )

    def get_pair_counts(self, environment: str | None = None) -> dict[str, dict[str, int]]:
        """Get pairwise co-occurrence counts across all arena sessions.

        Returns ``{model_id_a: {model_id_b: count, ...}, ...}`` where count
        is how many rounds the two model IDs appeared together.
        """
        args: dict = {}
        if environment is not None:
            args["environment"] = environment
        return self.client.query("recommendations:getPairCounts", args)

    @staticmethod
    def _diverse_sample(
        candidates: list[dict],
        k: int,
        pair_counts: dict[str, dict[str, int]],
        seed_model_ids: list[str] | None = None,
    ) -> list[dict]:
        """Iterative weighted sampling: prefer under-tested pairings.

        Each pick is weighted by ``1 / (1 + sum_of_pair_counts_with_selected)``.
        *seed_model_ids* are pre-seeded as "already selected" (e.g. focus
        policies in calibrate mode) but are NOT added to the result.
        """
        selected_model_ids: list[str] = list(seed_model_ids) if seed_model_ids else []
        selected: list[dict] = []
        remaining = list(candidates)

        for pick_num in range(k):
            if not remaining:
                break

            # Compute weights
            weights: list[float] = []
            for c in remaining:
                mid = c["model_id"]
                total = sum(
                    pair_counts.get(mid, {}).get(sel, 0)
                    for sel in selected_model_ids
                )
                weights.append(1.0 / (1.0 + total))

            # Debug: show weights for first pick (or all if small pool)
            if pick_num == 0 or len(remaining) <= 6:
                print(f"  [diverse_sample] pick {pick_num + 1}/{k}, "
                      f"pool={len(remaining)} candidates:")
                for c, w in zip(remaining, weights):
                    print(f"    {c['model_id'].split('/')[-1]}: weight={w:.3f}")

            chosen = random.choices(remaining, weights=weights, k=1)[0]
            selected.append(chosen)
            selected_model_ids.append(chosen["model_id"])
            remaining.remove(chosen)

        return selected

    def get_recommended_opponents(
        self,
        num_opponents: int = 2,
        environment: str | None = None,
        exclude_model_ids: list[str] | None = None,
        pair_counts: dict[str, dict[str, int]] | None = None,
        seed_model_ids: list[str] | None = None,
    ) -> list[dict]:
        """Get model IDs of recommended opponents via diversity-weighted sampling.

        Fetches all candidates from the backend (sorted by ELO descending)
        and samples client-side to avoid deterministic Math.random() in
        Convex queries.

        Args:
            num_opponents: Number of opponents to recommend.
            environment: Filter to policies in this environment.
            exclude_model_ids: Model ID strings to exclude (e.g. the focus policy).
            pair_counts: Pairwise co-occurrence counts. If provided, uses
                diversity-aware weighted sampling instead of uniform random.
            seed_model_ids: Model IDs pre-seeded as "already selected" for
                weighting (e.g. focus policies in calibrate mode).
        """
        query_args: dict = {}
        if environment is not None:
            query_args["environment"] = environment
        if exclude_model_ids is not None:
            query_args["exclude_model_ids"] = exclude_model_ids
        candidates = self.client.query(
            "recommendations:getOpponents",
            query_args,
        )

        if len(candidates) <= num_opponents:
            return candidates

        if pair_counts is not None:
            return self._diverse_sample(
                candidates, num_opponents, pair_counts, seed_model_ids,
            )

        return random.sample(candidates, num_opponents)

    def add_rounds(
        self,
        session_id: str,
        policies: list[PolicyInput],
        rounds: list[RoundInput],
    ) -> str:
        """Append rounds to an existing eval session and update ELO."""
        return self._write(
            "eval-sessions/add-rounds",
            {
                "id": session_id,
                "policies": [p.to_dict() for p in policies],
                "rounds": [r.to_dict() for r in rounds],
            },
        )

    def get_rollout_session(self, dataset_repo: str) -> dict | None:
        """Look up an existing rollout session by dataset repo ID."""
        return self.client.query(
            "evalSessions:getByDatasetRepo",
            {"dataset_repo": dataset_repo, "session_mode": "rollout"},
        )

    def delete_session(self, session_id: str) -> dict:
        """Delete an eval session and recompute ELO for all policies."""
        return self._write("admin/delete-session", {"id": session_id})

    def remove_policy_from_session(self, session_id: str, model_id: str) -> dict:
        """Remove a policy from an eval session and recompute ELO."""
        return self._write(
            "admin/remove-policy-from-session",
            {"id": session_id, "model_id": model_id},
        )

    def register_dataset(self, dataset: DatasetInput) -> str:
        """Register a dataset in the arena for browsing."""
        return self._write("datasets/register", dataset.to_dict())

    def update_dataset_stats(
        self,
        repo_id: str,
        num_episodes: int,
        total_duration_seconds: float,
        num_success: int | None = None,
        num_failure: int | None = None,
        num_human_frames: int | None = None,
        num_policy_frames: int | None = None,
        num_autonomous_success: int | None = None,
    ):
        """Update derived dataset statistics through the ingest API."""
        args = {
            "repo_id": repo_id,
            "num_episodes": num_episodes,
            "total_duration_seconds": total_duration_seconds,
        }
        for key, value in {
            "num_success": num_success,
            "num_failure": num_failure,
            "num_human_frames": num_human_frames,
            "num_policy_frames": num_policy_frames,
            "num_autonomous_success": num_autonomous_success,
        }.items():
            if value is not None:
                args[key] = value
        return self._write("datasets/update-stats", args)

    def list_datasets(
        self,
        task: str | None = None,
        source_types: list[str] | None = None,
        dataset_roles: list[str] | None = None,
        trainable: bool | None = None,
    ) -> list[dict]:
        """List registered datasets, optionally filtered by task/source/role."""
        args: dict = {}
        if task is not None:
            args["task"] = task
        if trainable is not None:
            args["trainable"] = trainable
        if dataset_roles and len(dataset_roles) == 1:
            args["dataset_role"] = dataset_roles[0]
        if source_types and len(source_types) == 1:
            args["source_type"] = source_types[0]
        datasets = self.client.query("datasets:list", args)
        if source_types:
            datasets = [d for d in datasets if d["source_type"] in source_types]
        if dataset_roles:
            datasets = [d for d in datasets if d.get("dataset_role") in dataset_roles]
        return datasets

    def update_dataset_task(
        self, repo_id: str, task: str, environment: str
    ) -> str:
        """Re-categorize a dataset to a different task/environment."""
        return self._write(
            "curation/update-dataset-task",
            {"repo_id": repo_id, "task": task, "environment": environment},
        )

    def update_policy_environment(self, model_id: str, environment: str) -> str:
        """Re-categorize a policy to a different environment."""
        return self._write(
            "curation/update-policy-environment",
            {"model_id": model_id, "environment": environment},
        )

    def set_policy_links(
        self,
        model_id: str,
        model_url: str | None = None,
        training_url: str | None = None,
    ):
        """Update the model and training links for a policy."""
        args = {"model_id": model_id}
        if model_url is not None:
            args["model_url"] = model_url
        if training_url is not None:
            args["training_url"] = training_url
        return self._write("curation/set-policy-links", args)

    def set_session_excluded(
        self,
        session_id: str,
        excluded: bool,
        reason: str | None = None,
    ):
        """Include or exclude a session from derived metrics."""
        args = {"id": session_id, "excluded": excluded}
        if reason is not None:
            args["exclusion_reason"] = reason
        return self._write("curation/set-excluded", args)

    def update_session_notes(self, session_id: str, notes: str):
        """Update an evaluation session's notes."""
        return self._write(
            "curation/update-notes", {"id": session_id, "notes": notes}
        )

    def delete_policy(self, model_id: str):
        """Delete a policy that has no remaining round results."""
        return self._write("admin/delete-policy", {"model_id": model_id})

    def delete_dataset(self, repo_id: str):
        """Delete a dataset registry entry."""
        return self._write("admin/delete-dataset", {"repo_id": repo_id})

    def get_leaderboard(self) -> list[dict]:
        """Get current leaderboard."""
        return self.client.query("policies:leaderboard")
