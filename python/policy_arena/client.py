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

    def get_recommended_opponents(
        self,
        num_opponents: int = 2,
        environment: str | None = None,
        exclude_artifacts: list[str] | None = None,
    ) -> list[dict]:
        """Get W&B artifacts of recommended opponents via ELO-stratified sampling.

        Fetches all candidates from the backend (sorted by ELO descending)
        and samples client-side to avoid deterministic Math.random() in
        Convex queries.

        Args:
            num_opponents: Number of opponents to recommend.
            environment: Filter to policies in this environment.
            exclude_artifacts: W&B artifact strings to exclude (e.g. the focus policy).
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
