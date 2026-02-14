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
    ) -> str:
        """Submit evaluation results. Policies are auto-registered."""
        args = {
            "dataset_repo": dataset_repo,
            "policies": [p.to_dict() for p in policies],
            "rounds": [r.to_dict() for r in rounds],
        }
        if notes is not None:
            args["notes"] = notes
        return self.client.mutation("evalSessions:submit", args)

    def get_recommended_opponents(self, num_opponents: int = 2) -> list[dict]:
        """Get W&B artifacts of recommended opponents."""
        return self.client.query(
            "recommendations:getOpponents",
            {"num_opponents": num_opponents},
        )

    def get_leaderboard(self) -> list[dict]:
        """Get current leaderboard."""
        return self.client.query("policies:leaderboard")
