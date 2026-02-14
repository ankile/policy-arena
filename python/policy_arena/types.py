from dataclasses import dataclass


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

    def to_dict(self) -> dict:
        return {
            "wandb_artifact": self.wandb_artifact,
            "success": self.success,
            "episode_index": self.episode_index,
        }


@dataclass
class RoundInput:
    round_index: int
    results: list[RoundResultInput]

    def to_dict(self) -> dict:
        return {
            "round_index": self.round_index,
            "results": [r.to_dict() for r in self.results],
        }
