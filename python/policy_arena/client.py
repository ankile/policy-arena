import random

from convex import ConvexClient

from policy_arena.types import DatasetInput, PolicyInput, RoundInput


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

    def get_pair_counts(self, environment: str | None = None) -> dict[str, dict[str, int]]:
        """Get pairwise co-occurrence counts across all arena sessions.

        Returns ``{artifact_a: {artifact_b: count, ...}, ...}`` where count
        is how many rounds the two artifacts appeared together.
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
        seed_artifacts: list[str] | None = None,
    ) -> list[dict]:
        """Iterative weighted sampling: prefer under-tested pairings.

        Each pick is weighted by ``1 / (1 + sum_of_pair_counts_with_selected)``.
        *seed_artifacts* are pre-seeded as "already selected" (e.g. focus
        policies in calibrate mode) but are NOT added to the result.
        """
        selected_artifacts: list[str] = list(seed_artifacts) if seed_artifacts else []
        selected: list[dict] = []
        remaining = list(candidates)

        for pick_num in range(k):
            if not remaining:
                break

            # Compute weights
            weights: list[float] = []
            for c in remaining:
                art = c["wandb_artifact"]
                total = sum(
                    pair_counts.get(art, {}).get(sel, 0)
                    for sel in selected_artifacts
                )
                weights.append(1.0 / (1.0 + total))

            # Debug: show weights for first pick (or all if small pool)
            if pick_num == 0 or len(remaining) <= 6:
                print(f"  [diverse_sample] pick {pick_num + 1}/{k}, "
                      f"pool={len(remaining)} candidates:")
                for c, w in zip(remaining, weights):
                    print(f"    {c['wandb_artifact'].split('/')[-1]}: weight={w:.3f}")

            chosen = random.choices(remaining, weights=weights, k=1)[0]
            selected.append(chosen)
            selected_artifacts.append(chosen["wandb_artifact"])
            remaining.remove(chosen)

        return selected

    def get_recommended_opponents(
        self,
        num_opponents: int = 2,
        environment: str | None = None,
        exclude_artifacts: list[str] | None = None,
        pair_counts: dict[str, dict[str, int]] | None = None,
        seed_artifacts: list[str] | None = None,
    ) -> list[dict]:
        """Get W&B artifacts of recommended opponents via diversity-weighted sampling.

        Fetches all candidates from the backend (sorted by ELO descending)
        and samples client-side to avoid deterministic Math.random() in
        Convex queries.

        Args:
            num_opponents: Number of opponents to recommend.
            environment: Filter to policies in this environment.
            exclude_artifacts: W&B artifact strings to exclude (e.g. the focus policy).
            pair_counts: Pairwise co-occurrence counts. If provided, uses
                diversity-aware weighted sampling instead of uniform random.
            seed_artifacts: Artifacts pre-seeded as "already selected" for
                weighting (e.g. focus policies in calibrate mode).
        """
        query_args: dict = {}
        if environment is not None:
            query_args["environment"] = environment
        if exclude_artifacts is not None:
            query_args["exclude_artifacts"] = exclude_artifacts
        candidates = self.client.query(
            "recommendations:getOpponents",
            query_args,
        )

        if len(candidates) <= num_opponents:
            return candidates

        if pair_counts is not None:
            return self._diverse_sample(
                candidates, num_opponents, pair_counts, seed_artifacts,
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
