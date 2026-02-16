import random

from convex import ConvexClient

from policy_arena.types import PolicyInput, RoundInput


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

        # ELO-stratified sampling: pick from top, bottom, then middle thirds
        third_size = max(1, len(candidates) // 3)
        top_third = candidates[:third_size]
        bottom_third = candidates[-third_size:]
        middle_third = candidates[third_size:-third_size]

        picks: list[dict] = []
        picked_artifacts: set[str] = set()

        def pick_from(pool: list[dict]) -> dict | None:
            available = [p for p in pool if p["wandb_artifact"] not in picked_artifacts]
            if not available:
                return None
            choice = random.choice(available)
            picks.append(choice)
            picked_artifacts.add(choice["wandb_artifact"])
            return choice

        pick_from(top_third)
        if len(picks) < num_opponents:
            pick_from(bottom_third)
        while len(picks) < num_opponents and middle_third:
            if pick_from(middle_third) is None:
                break
        # If still short (e.g. very few policies), fill from any remaining
        while len(picks) < num_opponents:
            remaining = [c for c in candidates if c["wandb_artifact"] not in picked_artifacts]
            if not remaining:
                break
            pick_from(remaining)

        return picks

    def delete_session(self, session_id: str) -> dict:
        """Delete an eval session and recompute ELO for all policies."""
        return self.client.mutation(
            "evalSessions:deleteSession", {"id": session_id}
        )

    def get_leaderboard(self) -> list[dict]:
        """Get current leaderboard."""
        return self.client.query("policies:leaderboard")
