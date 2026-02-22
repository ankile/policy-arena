import random

from convex import ConvexClient

from policy_arena.types import DatasetInput, PolicyInput, RoundInput, RoundResultInput


class PolicyArenaClient:
    def __init__(self, url: str):
        self.client = ConvexClient(url)

    def submit_eval_session(
        self,
        dataset_repo: str,
        policies: list[PolicyInput],
        rounds: list[RoundInput],
        notes: str | None = None,
        session_mode: str | None = None,
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
        return self.client.mutation("evalSessions:submit", args)

    def submit_rollout_session(
        self,
        dataset_repo: str,
        policy: PolicyInput,
        episodes: list[tuple[int, bool, int | None]],
        notes: str | None = None,
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
        return self.client.mutation(
            "evalSessions:addRounds",
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
        return self.client.mutation(
            "evalSessions:deleteSession", {"id": session_id}
        )

    def register_dataset(self, dataset: DatasetInput) -> str:
        """Register a dataset in the arena for browsing."""
        return self.client.mutation("datasets:register", dataset.to_dict())

    def list_datasets(
        self,
        task: str | None = None,
        source_types: list[str] | None = None,
    ) -> list[dict]:
        """List registered datasets, optionally filtered by task and source types."""
        args: dict = {}
        if task is not None:
            args["task"] = task
        datasets = self.client.query("datasets:list", args)
        if source_types:
            datasets = [d for d in datasets if d["source_type"] in source_types]
        return datasets

    def get_leaderboard(self) -> list[dict]:
        """Get current leaderboard."""
        return self.client.query("policies:leaderboard")
