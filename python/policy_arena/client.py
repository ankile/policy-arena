import json
import os
import random
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from convex import ConvexClient, ConvexInt64, convex_to_json, json_to_convex

from policy_arena.types import DatasetInput, PolicyInput, RoundInput, RoundResultInput

DEFAULT_API_KEY_PATH = "~/.config/sir/policy_arena_api_key"


class PolicyArenaAPIError(RuntimeError):
    """An authenticated Policy Arena write request failed."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        error_id: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.error_id = error_id


def _normalize_convex_json_numbers(value):
    """Restore Convex float64 values after Python's JSON decoder made them ints.

    Convex's JSON wire format wraps int64 values in ``$integer`` objects, but
    integral float64 values (timestamps in particular) are emitted as bare JSON
    numbers. ``json.loads`` turns those into Python ``int`` objects, which
    ``json_to_convex`` correctly rejects as ambiguous. Bare numbers are
    therefore float64; wrapped integers remain untouched for the Convex decoder.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return float(value)
    if isinstance(value, list):
        return [_normalize_convex_json_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_convex_json_numbers(item) for key, item in value.items()}
    return value


def load_api_key() -> str | None:
    """Resolve this machine's Policy Arena API key.

    Order: POLICY_ARENA_API_KEY env var, then POLICY_ARENA_API_KEY_PATH
    (default ~/.config/sir/policy_arena_api_key). Returns None when neither is
    configured; mutations then fail loudly at call time.
    """
    api_key = os.environ.get("POLICY_ARENA_API_KEY")
    if api_key and api_key.strip():
        return api_key.strip()
    path = Path(
        os.path.expanduser(
            os.environ.get("POLICY_ARENA_API_KEY_PATH", DEFAULT_API_KEY_PATH)
        )
    )
    if not path.exists():
        return None
    api_key = path.read_text().strip()
    return api_key or None


class PolicyArenaClient:
    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        api_url: str | None = None,
        timeout_seconds: float = 30.0,
    ):
        self.client = ConvexClient(url)
        self._api_key = api_key if api_key is not None else load_api_key()
        self._api_url = api_url or self._default_api_url(url)
        self._timeout_seconds = timeout_seconds

    @staticmethod
    def _default_api_url(url: str) -> str:
        suffix = ".convex.cloud"
        if not url.endswith(suffix):
            raise ValueError(
                "api_url is required when the Convex URL does not end in .convex.cloud"
            )
        return f"{url.removesuffix(suffix)}.convex.site/api/v1"

    def whoami(self) -> dict:
        """Check the machine credential without writing: ``{"ok", "actor", "scopes"}``.

        Raises ``PolicyArenaAPIError`` when no key is installed or the API rejects it.
        Launch/split shells call this as a preflight so a stale key fails before any
        expensive work rather than after the HF pushes.
        """
        if self._api_key is None:
            raise PolicyArenaAPIError(
                "Policy Arena machine API key missing. Set POLICY_ARENA_API_KEY or write "
                f"the key to {DEFAULT_API_KEY_PATH} (override with POLICY_ARENA_API_KEY_PATH)."
            )
        request = Request(
            f"{self._api_url}/auth/whoami",
            headers={"Authorization": f"Bearer {self._api_key}"},
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                return json.loads(response.read())
        except HTTPError as error:
            raise PolicyArenaAPIError(
                f"Policy Arena credential rejected (HTTP {error.code}): "
                f"{error.read().decode(errors='replace')[:300]}",
                status=error.code,
            ) from error

    def _mutation(
        self,
        name: str,
        args: dict,
        idempotency_key: str | None = None,
    ):
        """Send an authenticated, scope-checked machine write."""
        if self._api_key is None:
            raise PolicyArenaAPIError(
                "Policy Arena mutations require a machine API key. Set "
                "POLICY_ARENA_API_KEY or write the key to "
                f"{DEFAULT_API_KEY_PATH} (override with POLICY_ARENA_API_KEY_PATH)."
            )

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        operation = name.replace(":", "/")
        request = Request(
            f"{self._api_url}/mutate/{operation}",
            data=json.dumps(convex_to_json(args)).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                payload = json.loads(response.read())
        except HTTPError as error:
            payload = json.loads(error.read())
            error_id = payload.get("error_id")
            suffix = f" [error_id={error_id}]" if error_id is not None else ""
            raise PolicyArenaAPIError(
                f"Policy Arena write failed with HTTP {error.code}: "
                f"{payload['error']}{suffix}",
                status=error.code,
                code=payload.get("code"),
                error_id=error_id,
            ) from error

        if payload["ok"] is not True:
            raise PolicyArenaAPIError(
                payload["error"],
                code=payload.get("code"),
                error_id=payload.get("error_id"),
            )
        return json_to_convex(_normalize_convex_json_numbers(payload["value"]))

    def submit_eval_session(
        self,
        dataset_repo: str,
        policies: list[PolicyInput],
        rounds: list[RoundInput],
        notes: str | None = None,
        session_mode: str | None = None,
        status: str | None = None,
        operator: str | None = None,
        idempotency_key: str | None = None,
    ) -> str:
        """Submit evaluation results. Policies are auto-registered.

        ``status`` tags the session at submit time (e.g. "ablation" or
        "testing") so it never appears in the arena's default mainline view.
        ``operator`` is the HF username of the human who physically ran the
        eval (must exist in the arena's ``operators`` registry — see
        :meth:`add_operator`).
        """
        args = {
            "dataset_repo": dataset_repo,
            "policies": [p.to_dict() for p in policies],
            "rounds": [r.to_dict() for r in rounds],
        }
        if notes is not None:
            args["notes"] = notes
        if session_mode is not None:
            args["session_mode"] = session_mode
        if status is not None:
            args["status"] = status
        if operator is not None:
            args["operator"] = operator
        return self._mutation(
            "evalSessions:submit",
            args,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def set_session_operator(self, session_id: str, operator: str) -> str:
        """Set the operator (HF username, from the operators registry) on a session."""
        return self._mutation("evalSessions:setOperator", {"id": session_id, "operator": operator})

    def add_operator(self, hf_username: str) -> str:
        """Register an eval operator (HF username) in the arena's operators registry."""
        return self._mutation("operators:add", {"hf_username": hf_username})

    def list_operators(self) -> list[dict]:
        """List registered eval operators."""
        return self.client.query("operators:list", {})

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

    def refresh_dataset_stats(self, repo_id: str) -> float:
        """Queue an authoritative, revision-pinned dataset stats refresh."""
        return self._mutation("datasets:refreshStats", {"repo_id": repo_id})

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
        """Update legacy dataset counters through the ingest API."""
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
        return self._mutation("datasets:updateStats", args)

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

    # -- Lifecycle statuses (mainline | retired | ablation | testing) --------
    # Task-level status is the default for everything under that task; the
    # per-entity setters below override it, and status="inherit" clears the
    # override. See convex/statusShared.ts for resolution semantics.

    def set_task_status(
        self,
        task: str,
        status: str,
        reason: str | None = None,
        superseded_by: str | None = None,
    ) -> str:
        """Declarative upsert: omitted reason/superseded_by are cleared."""
        args: dict = {"task": task, "status": status}
        if reason is not None:
            args["reason"] = reason
        if superseded_by is not None:
            args["superseded_by"] = superseded_by
        return self._mutation("statuses:setTaskStatus", args)

    def list_task_statuses(self) -> list[dict]:
        return self.client.query("statuses:listTaskStatuses", {})

    def set_policy_status(
        self, model_id: str, status: str, status_reason: str | None = None
    ) -> str:
        args: dict = {"model_id": model_id, "status": status}
        if status_reason is not None:
            args["status_reason"] = status_reason
        return self._mutation("policies:setStatus", args)

    def set_session_status(
        self, session_id: str, status: str, status_reason: str | None = None
    ) -> str:
        args: dict = {"id": session_id, "status": status}
        if status_reason is not None:
            args["status_reason"] = status_reason
        return self._mutation("evalSessions:setStatus", args)

    def set_dataset_status(
        self, repo_id: str, status: str, status_reason: str | None = None
    ) -> str:
        args: dict = {"repo_id": repo_id, "status": status}
        if status_reason is not None:
            args["status_reason"] = status_reason
        return self._mutation("datasets:setStatus", args)

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
        self,
        dataset_repo: str,
        *,
        taxonomy_version: str,
        keep_episode_indices: list[int],
        task: str | None = None,
    ) -> int:
        """Delete prefills for episodes NOT in this push (wholesale-replace tail).

        Pass ``task`` so a repo hypothetically holding two tasks' prefills under
        one shared taxonomy string ("s7_v1" is shared by four lines) can never
        have the other task's rows deleted.
        """
        args: dict = {
            "dataset_repo": dataset_repo,
            "taxonomy_version": taxonomy_version,
            "keep_episode_indices": [ConvexInt64(int(e)) for e in keep_episode_indices],
        }
        if task is not None:
            args["task"] = task
        result = self._mutation("stagePrefills:pruneStale", args)
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

    def cancel_apply_job(self, job_id: str) -> str:
        """Cancel a pending or stale-applying job through the service path."""
        return self._mutation("applyJobs:cancel", {"id": job_id})

    def correct_eval_outcomes(self, dataset_repo: str, corrections: list[dict]) -> dict:
        """Patch an eval session in place after an outcome-review apply."""
        normalized = [
            {
                "episode_index": ConvexInt64(int(row["episode_index"])),
                "success": bool(row["success"]),
                "num_frames": ConvexInt64(int(row["num_frames"])),
            }
            for row in corrections
        ]
        return self._mutation(
            "evalSessions:correctOutcomesFromApply",
            {"dataset_repo": dataset_repo, "corrections": normalized},
        )

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
