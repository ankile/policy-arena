from dataclasses import dataclass

from convex import ConvexInt64


@dataclass
class PolicyInput:
    name: str
    wandb_artifact: str
    environment: str
    wandb_run_url: str | None = None

    def to_dict(self) -> dict:
        d = {
            "name": self.name,
            "wandb_artifact": self.wandb_artifact,
            "environment": self.environment,
        }
        if self.wandb_run_url is not None:
            d["wandb_run_url"] = self.wandb_run_url
        return d


@dataclass
class RoundResultInput:
    wandb_artifact: str
    success: bool
    episode_index: int
    num_frames: int | None = None

    def to_dict(self) -> dict:
        d = {
            "wandb_artifact": self.wandb_artifact,
            "success": self.success,
            "episode_index": ConvexInt64(self.episode_index),
        }
        if self.num_frames is not None:
            d["num_frames"] = ConvexInt64(self.num_frames)
        return d


@dataclass
class RoundInput:
    round_index: int
    results: list[RoundResultInput]

    def to_dict(self) -> dict:
        return {
            "round_index": ConvexInt64(self.round_index),
            "results": [r.to_dict() for r in self.results],
        }


@dataclass
class DatasetInput:
    repo_id: str
    name: str
    task: str
    source_type: str  # "teleop" | "rollout" | "dagger" | "eval"
    environment: str
    num_episodes: int | None = None
    wandb_artifact: str | None = None
    notes: str | None = None

    def to_dict(self) -> dict:
        d = {
            "repo_id": self.repo_id,
            "name": self.name,
            "task": self.task,
            "source_type": self.source_type,
            "environment": self.environment,
        }
        if self.num_episodes is not None:
            d["num_episodes"] = ConvexInt64(self.num_episodes)
        if self.wandb_artifact is not None:
            d["wandb_artifact"] = self.wandb_artifact
        if self.notes is not None:
            d["notes"] = self.notes
        return d
