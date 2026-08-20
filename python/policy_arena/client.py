import os
import random

from convex import ConvexClient, ConvexInt64

from policy_arena.types import DatasetInput, PolicyInput, RoundInput, RoundResultInput

DEFAULT_TOKEN_PATH = "~/.config/sir/policy_arena_token"


def load_service_token() -> str | None:
    """Resolve the arena service token for machine writes.

    Order: POLICY_ARENA_TOKEN env var, then the file at POLICY_ARENA_TOKEN_PATH
    (default ~/.config/sir/policy_arena_token). Returns None when neither is
    configured; mutations then fail loudly at call time.
    """
    token = os.environ.get("POLICY_ARENA_TOKEN")
    if token and token.strip():
        return token.strip()
    path = os.path.expanduser(
        os.environ.get("POLICY_ARENA_TOKEN_PATH", DEFAULT_TOKEN_PATH)
    )
    try:
        with open(path) as f:
            token = f.read().strip()
    except FileNotFoundError:
        return None
    return token or None


class PolicyArenaClient:
    def __init__(self, url: str, service_token: str | None = None):
        self.client = ConvexClient(url)
        self._service_token = (
            service_token if service_token is not None else load_service_token()
        )

    def _mutation(self, name: str, args: dict):
        """All arena mutations are auth-gated; attach the service token."""
        if self._service_token is None:
            raise RuntimeError(
                "Policy Arena mutations require a service token. Set the "
                "POLICY_ARENA_TOKEN env var or write the token to "
                f"{DEFAULT_TOKEN_PATH} (override path with POLICY_ARENA_TOKEN_PATH)."
            )
        return self.client.mutation(
            name, {**args, "serviceToken": self._service_token}
        )

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
        return self._mutation("evalSessions:submit", args)

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
        return self._mutation(
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
        return self._mutation(
            "evalSessions:deleteSession", {"id": session_id}
        )

    def remove_policy_from_session(self, session_id: str, model_id: str) -> dict:
        """Remove a policy from an eval session and recompute ELO."""
        return self._mutation(
            "evalSessions:removePolicyFromSession",
            {"id": session_id, "model_id": model_id},
        )

    def register_dataset(self, dataset: DatasetInput) -> str:
        """Register a dataset in the arena for browsing."""
        return self._mutation("datasets:register", dataset.to_dict())

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
        return self._mutation(
            "datasets:updateTask",
            {"repo_id": repo_id, "task": task, "environment": environment},
        )

    def update_policy_environment(self, model_id: str, environment: str) -> str:
        """Re-categorize a policy to a different environment."""
        return self._mutation(
            "policies:updateEnvironment",
            {"model_id": model_id, "environment": environment},
        )

    def get_leaderboard(self) -> list[dict]:
        """Get current leaderboard."""
        return self.client.query("policies:leaderboard")

    # ── Outcome review + apply-job bridge (arena review worker) ──

    def fetch_outcome_reviews(self, dataset_repo: str) -> dict:
        """Latest outcome review per episode for a repo.

        Returns {"episodes": [...], "num_confirmed": int, "num_skipped": int}
        where each episode row carries status/new_outcome/outcome_frame/
        soft_truncate/subtask_frames/reviewer.
        """
        return self.client.query(
            "reviews:latestForRepo", {"dataset_repo": dataset_repo}
        )

    def save_outcome_review(
        self,
        dataset_repo: str,
        episode_index: int,
        status: str,
        *,
        new_outcome: str | None = None,
        outcome_frame: int | None = None,
        soft_truncate: bool | None = None,
        subtask_frames: list[int] | None = None,
        reviewer_override: str | None = None,
    ) -> str:
        """Record an outcome review (service path — e.g. cv2-era backfills)."""
        args: dict = {
            "dataset_repo": dataset_repo,
            "episode_index": ConvexInt64(int(episode_index)),
            "status": status,
        }
        if new_outcome is not None:
            args["new_outcome"] = new_outcome
        if outcome_frame is not None:
            args["outcome_frame"] = ConvexInt64(int(outcome_frame))
        if soft_truncate is not None:
            args["soft_truncate"] = bool(soft_truncate)
        if subtask_frames is not None:
            args["subtask_frames"] = [ConvexInt64(int(f)) for f in subtask_frames]
        if reviewer_override is not None:
            args["reviewer_override"] = reviewer_override
        return self._mutation("reviews:save", args)

    def upsert_task_spec(
        self,
        *,
        task: str,
        task_name: str,
        num_subtask_marks: int,
        stored_frame_hw: tuple[int, int],
        camera_keys_by_role: dict[str, str],
        crop_boxes: dict[str, tuple[int, int, int, int]],
        review_camera_roles: tuple[str, ...],
        source: str,
    ) -> str:
        """Export one task's registry-derived review spec (service-only)."""
        return self._mutation(
            "taskSpecs:upsert",
            {
                "task": task,
                "task_name": task_name,
                "num_subtask_marks": ConvexInt64(int(num_subtask_marks)),
                "stored_frame_hw": [ConvexInt64(int(v)) for v in stored_frame_hw],
                "camera_keys_by_role": dict(camera_keys_by_role),
                "crop_boxes": {
                    role: [ConvexInt64(int(v)) for v in box]
                    for role, box in crop_boxes.items()
                },
                "review_camera_roles": list(review_camera_roles),
                "source": source,
            },
        )

    def get_task_spec(self, task: str) -> dict | None:
        return self.client.query("taskSpecs:forTask", {"task": task})

    def upsert_stage_task_spec(
        self,
        *,
        task: str,
        taxonomy_version: str,
        taxonomy_hash: str,
        live: bool,
        spec: dict,
        source: str,
    ) -> str:
        """Export one stage-label taxonomy version's full spec (service-only).

        ``spec`` is the raw ``serialize_stage_spec`` payload; it is stored as an
        opaque document, so plain Python ints are fine (they arrive in the UI as
        float64 Numbers — deliberately no ConvexInt64 wrapping here).
        """
        return self._mutation(
            "stageTaskSpecs:upsert",
            {
                "task": task,
                "taxonomy_version": taxonomy_version,
                "taxonomy_hash": taxonomy_hash,
                "live": bool(live),
                "spec": spec,
                "source": source,
            },
        )

    def get_stage_task_specs(self, task: str) -> list[dict]:
        """Every exported taxonomy version for a task (live + candidates)."""
        return self.client.query("stageTaskSpecs:forTask", {"task": task})

    def push_stage_prefills(
        self, rows: list[dict], *, source: str, chunk_size: int = 50
    ) -> dict:
        """Push labeling-pipeline predictions as review prefills (service-only).

        Each row must carry task / dataset_repo / episode_index /
        taxonomy_version / label / pipeline / evidence (see
        ``stagePrefills.upsertBatch``). ``episode_index`` is wrapped to int64
        here; everything else is sent as-is (numbers arrive as float64, which
        the UI and the gold exporter both handle).
        """
        if not rows:
            raise ValueError("push_stage_prefills called with zero rows")
        totals = {"inserted": 0, "replaced": 0}
        for start in range(0, len(rows), chunk_size):
            chunk = [
                {**row, "episode_index": ConvexInt64(int(row["episode_index"]))}
                for row in rows[start : start + chunk_size]
            ]
            result = self._mutation(
                "stagePrefills:upsertBatch", {"rows": chunk, "source": source}
            )
            totals["inserted"] += int(result["inserted"])
            totals["replaced"] += int(result["replaced"])
        return totals

    def prune_stale_stage_prefills(
        self, dataset_repo: str, *, taxonomy_version: str, keep_episode_indices: list[int]
    ) -> int:
        """Delete prefills for episodes NOT in this push (wholesale-replace tail)."""
        result = self._mutation(
            "stagePrefills:pruneStale",
            {
                "dataset_repo": dataset_repo,
                "taxonomy_version": taxonomy_version,
                "keep_episode_indices": [ConvexInt64(int(e)) for e in keep_episode_indices],
            },
        )
        return int(result["pruned"])

    def fetch_stage_prefills(
        self, dataset_repo: str, *, taxonomy_version: str | None = None
    ) -> list[dict]:
        """Prefill rows for a repo. NOTE: int64 fields (``episode_index``) come
        back as ``ConvexInt64`` — use ``.value`` or ``int()`` on ``.value``."""
        args: dict = {"dataset_repo": dataset_repo}
        if taxonomy_version is not None:
            args["taxonomy_version"] = taxonomy_version
        return self.client.query("stagePrefills:forRepo", args)

    def save_stage_review(
        self,
        *,
        task: str,
        dataset_repo: str,
        episode_index: int,
        taxonomy_version: str,
        status: str,
        label: dict | None = None,
        notes: str | None = None,
        episode_duration_s: float | None = None,
        reviewer_override: str | None = None,
        saved_at_override: float | None = None,
    ) -> str:
        """Record a stage review (service path — parity replays and backfills)."""
        args: dict = {
            "task": task,
            "dataset_repo": dataset_repo,
            "episode_index": ConvexInt64(int(episode_index)),
            "taxonomy_version": taxonomy_version,
            "status": status,
        }
        if label is not None:
            args["label"] = label
        if notes is not None:
            args["notes"] = notes
        if episode_duration_s is not None:
            args["episode_duration_s"] = float(episode_duration_s)
        if reviewer_override is not None:
            args["reviewer_override"] = reviewer_override
        if saved_at_override is not None:
            args["saved_at_override"] = float(saved_at_override)
        return self._mutation("stageReviews:save", args)

    def fetch_stage_reviews(
        self, dataset_repo: str, *, taxonomy_version: str | None = None
    ) -> dict:
        """Latest non-cleared stage review per (episode, taxonomy, reviewer)."""
        args: dict = {"dataset_repo": dataset_repo}
        if taxonomy_version is not None:
            args["taxonomy_version"] = taxonomy_version
        return self.client.query("stageReviews:latestForRepo", args)

    def stage_review_repos_for_task(self, task: str) -> list[str]:
        """Distinct dataset repos holding stage reviews for a task."""
        return self.client.query("stageReviews:reposForTask", {"task": task})

    def enqueue_apply_job(self, dataset_repo: str, *, dry_run: bool = False) -> str:
        return self._mutation(
            "applyJobs:enqueue", {"dataset_repo": dataset_repo, "dry_run": dry_run}
        )

    def claim_apply_job(self, worker_id: str) -> dict | None:
        """Claim the oldest pending apply job; None when the queue is empty."""
        return self._mutation("applyJobs:claim", {"worker_id": worker_id})

    def finish_apply_job(
        self,
        job_id: str,
        *,
        ok: bool,
        hf_commit_sha: str | None = None,
        pre_apply_sha: str | None = None,
        error: str | None = None,
        log_tail: str | None = None,
        num_confirmed: int | None = None,
        num_skipped: int | None = None,
    ) -> str:
        args: dict = {"id": job_id, "ok": ok}
        if hf_commit_sha is not None:
            args["hf_commit_sha"] = hf_commit_sha
        if pre_apply_sha is not None:
            args["pre_apply_sha"] = pre_apply_sha
        if error is not None:
            args["error"] = error
        if log_tail is not None:
            args["log_tail"] = log_tail
        if num_confirmed is not None:
            args["num_confirmed"] = ConvexInt64(int(num_confirmed))
        if num_skipped is not None:
            args["num_skipped"] = ConvexInt64(int(num_skipped))
        return self._mutation("applyJobs:finish", args)

    def worker_heartbeat(self, worker_id: str, info: str | None = None) -> str:
        args: dict = {"worker_id": worker_id}
        if info is not None:
            args["info"] = info
        return self._mutation("applyJobs:beat", args)
