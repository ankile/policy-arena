"""Backfill Arena review rows for cv2-era outcome decisions already on HF.

`reconcile_applied_outcome_frames.py` found two repos whose HF
`.outcome_edit_progress.json` holds decisions with no Arena review row: they
were made with the local cv2 editor (`sir/tools/outcome_editor.py`) before the
web review flow existed, and only the later web reviews (2 per repo) have rows.
This script inserts one row per missing episode so the Arena fold equals the HF
record for every reviewed episode.

Provenance (from `.label_history.jsonl` at the pinned sha; the cv2 events were
reconstructed by the 2026-08-19 label-history bootstrap from commit
archaeology, so `ts` is the time of the HF commit that carried the cv2
progress record, not the keystroke time):

- real01b-md2-r5-repeat-...-s2026070704 @ ccf86378: 150 progress records
  (92 changed, 58 skipped). Arena has web rows for ep 7 and 50; ep 0 has only
  an e2e-smoke confirm (2026-08-19T04:53Z) that was cleared at 06:40Z, before
  the first applied job, so it folds to unreviewed and HF keeps the cv2 skip.
  For each of the other 148, the newest outcome event is
  `{kind: human, agent: ankile, tool: cv2-editor}` at 2026-08-18T19:10:26Z
  (post_sha 9dd53513), and its payload equals the HF record (`{"action":
  "skip"}` for skips).
- real01c-insert-marker-d1-blind-eval-r1-25k-sobol20 @ eff17de8: 80 records
  (62 changed, 18 skipped). Arena has rows for ep 0 and 39 (ts-apply-burnin).
  For each of the other 78, the newest outcome event is the same cv2-editor
  source at 2026-05-28T04:45:03Z (post_sha 4e626e53), payload equal to HF.

So every missing episode has a label-history event, and each row takes
reviewer = that event's agent, saved_at = its ts, and source_tool naming the
cv2 editor plus this backfill. Each row mirrors the HF record exactly: changed
-> `confirmed` with new_outcome / outcome_frame / soft_truncate, and
subtask_frames only when the record has that key (neither repo does; both
tasks have 0 subtask marks); skipped -> `skipped` with no outcome fields.

Rows go through the internal mutation `reviews:backfillAppliedRecords` (via
`npx convex run` against grandiose-rook-292, like the reconcile script). It
stamps `backfilled_from_hf_sha`, refuses episodes whose newest row is live and
repos with an active apply job, and does NOT enqueue an apply: the decisions
are already on HF. The freshness gate (`sir.real.lifecycle.arena_freshness`)
and the reconcile script treat these rows as applied, and `reviews:save`
refuses to clear them.

Guards, all checked before anything is written: HF `main` is still the pinned
sha; no apply job is pending/applying; the missing set has the pinned size;
each missing episode's newest label-history outcome event is a human
cv2-editor event whose payload equals the HF record; each outcome_frame is
inside the episode and is not a terminal is_valid=0 padding frame (a later
apply would leave it unchanged).

Run from the sir repo root:
  uv run python deps/policy_arena/scripts/backfill_missing_review_rows.py          # dry run
  uv run python deps/policy_arena/scripts/backfill_missing_review_rows.py --apply
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pyarrow.parquet as pq
from convex import ConvexClient, ConvexInt64, convex_to_json
from huggingface_hub import HfApi, HfFileSystem, hf_hub_download

CONVEX_URL = "https://grandiose-rook-292.convex.cloud"
ARENA_DIR = Path(__file__).resolve().parents[1]
PROGRESS_FILENAME = ".outcome_edit_progress.json"
HISTORY_FILENAME = ".label_history.jsonl"
CV2_SOURCE = {"kind": "human", "agent": "ankile", "tool": "cv2-editor"}
SOURCE_TOOL = (
    "cv2-editor (sir/tools/outcome_editor.py); row backfilled from the HF progress record "
    "by policy_arena/scripts/backfill_missing_review_rows.py"
)
RECORD_KEYS = {"new_outcome", "outcome_frame", "soft_truncate", "subtask_frames"}

# repo -> (HF main sha the evidence was read at, number of HF records without a row)
PINS: dict[str, tuple[str, int]] = {
    "ankile/real01b-md2-r5-repeat-base-dp-filmtiidk4-c200k-n32-s2026070704": (
        "ccf86378f9d34e03447f09fc125db54b8303c47e",
        148,
    ),
    "ankile/real01c-insert-marker-d1-blind-eval-r1-25k-sobol20": (
        "eff17de847bd90c300205b41d013a89d7592783c",
        78,
    ),
}


def as_int(value) -> int:
    return int(value.value) if isinstance(value, ConvexInt64) else int(value)


def episode_frames(fs: HfFileSystem, repo: str, sha: str, episodes: set[int]) -> dict[int, dict]:
    """length, and (when the data has is_valid) terminal validity + last valid frame."""
    root = f"datasets/{repo}@{sha}"
    meta_cols = ["episode_index", "length", "data/chunk_index", "data/file_index"]
    files: dict[str, set[int]] = {}
    out: dict[int, dict] = {}
    for path in sorted(fs.glob(f"{root}/meta/episodes/**/*.parquet")):
        with fs.open(path, "rb") as fh:
            meta = pq.read_table(fh, columns=meta_cols).to_pylist()
        for row in meta:
            ep = int(row["episode_index"])
            if ep not in episodes:
                continue
            out[ep] = {"length": int(row["length"])}
            data = (
                f"{root}/data/chunk-{int(row['data/chunk_index']):03d}/"
                f"file-{int(row['data/file_index']):03d}.parquet"
            )
            files.setdefault(data, set()).add(ep)
    missing = episodes - out.keys()
    if missing:
        raise RuntimeError(f"{repo}@{sha}: episodes {sorted(missing)} absent from meta/episodes")
    for path, eps in sorted(files.items()):
        with fs.open(path, "rb") as fh:
            if "is_valid" not in pq.read_schema(fh).names:
                continue  # no is_valid: apply normalization is the identity
        with fs.open(path, "rb") as fh:
            table = pq.read_table(
                fh, columns=["episode_index", "frame_index", "is_valid"]
            ).to_pydict()
        by_ep: dict[int, list[tuple[int, int]]] = {}
        for ep, frame, valid in zip(
            table["episode_index"], table["frame_index"], table["is_valid"], strict=True
        ):
            if int(ep) in eps:
                by_ep.setdefault(int(ep), []).append((int(frame), int(valid)))
        for ep in eps:
            frames = sorted(by_ep[ep])
            if [f for f, _ in frames] != list(range(out[ep]["length"])):
                raise RuntimeError(f"{path}: episode {ep} frames do not match meta length")
            out[ep]["terminal_valid"] = frames[-1][1]
            out[ep]["last_valid"] = max(f for f, valid in frames if valid == 1)
    return out


def ts_to_ms(ts: str) -> float:
    return datetime.fromisoformat(ts).timestamp() * 1000.0


def plan_repo(arena: ConvexClient, hf: HfApi, fs: HfFileSystem, repo: str) -> list[dict]:
    """The rows to insert for `repo`, after every guard passes."""
    sha, expected_missing = PINS[repo]
    main = hf.repo_info(repo, repo_type="dataset", revision="main").sha
    if main != sha:
        raise RuntimeError(f"{repo}: HF main moved {sha} -> {main}; re-derive the evidence")
    jobs = arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0})
    active = [j for j in jobs if j["status"] in ("pending", "applying")]
    if active:
        raise RuntimeError(f"{repo}: apply job {active[0]['_id']} is {active[0]['status']}")

    progress = json.loads(
        Path(
            hf_hub_download(repo, PROGRESS_FILENAME, repo_type="dataset", revision=sha)
        ).read_text()
    )
    changed: dict[str, dict] = progress["changed_episodes"]
    skipped = [int(e) for e in progress["skipped_episodes"]]
    if len(set(skipped)) != len(skipped) or {int(e) for e in changed} & set(skipped):
        raise RuntimeError(f"{repo}: progress record lists an episode twice")
    hf_eps = {int(e) for e in changed} | set(skipped)

    rows = arena.query("reviews:latestForRepo", {"dataset_repo": repo})["episodes"]
    arena_eps = {as_int(row["episode_index"]) for row in rows}
    missing = sorted(hf_eps - arena_eps)
    if not missing:
        return []
    if len(missing) != expected_missing:
        raise RuntimeError(
            f"{repo}: {len(missing)} records without a row, pinned {expected_missing}"
        )

    history_path = hf_hub_download(repo, HISTORY_FILENAME, repo_type="dataset", revision=sha)
    events = [json.loads(line) for line in Path(history_path).read_text().splitlines() if line]
    outcome_events = [e for e in events if e["label_kind"] == "outcome"]
    stamps = [e["ts"] for e in outcome_events]
    if stamps != sorted(stamps):
        raise RuntimeError(f"{repo}: label-history outcome events are not in time order")
    newest: dict[int, dict] = {}
    for event in outcome_events:
        newest[int(event["episode_index"])] = event

    frames = episode_frames(fs, repo, sha, {ep for ep in missing if str(ep) in changed})
    plan = []
    for ep in missing:
        event = newest.get(ep)
        if event is None:
            raise RuntimeError(f"{repo} ep {ep}: no label-history outcome event")
        if event["source"] != CV2_SOURCE:
            raise RuntimeError(f"{repo} ep {ep}: newest event source {event['source']} is not cv2")
        row = {
            "episode_index": ConvexInt64(ep),
            "reviewer": event["source"]["agent"],
            "source_tool": SOURCE_TOOL,
            "saved_at": ts_to_ms(event["ts"]),
        }
        record = changed.get(str(ep))
        if record is None:
            if event["payload"] != {"action": "skip"}:
                raise RuntimeError(f"{repo} ep {ep}: HF skip but event {event['payload']}")
            row["status"] = "skipped"
        else:
            if event["payload"] != record:
                raise RuntimeError(f"{repo} ep {ep}: event {event['payload']} != HF {record}")
            if set(record) - RECORD_KEYS:
                raise RuntimeError(f"{repo} ep {ep}: unexpected record keys {sorted(record)}")
            frame = int(record["outcome_frame"])
            info = frames[ep]
            if not 0 <= frame < info["length"]:
                raise RuntimeError(f"{repo} ep {ep}: outcome_frame {frame} outside {info}")
            if (
                info.get("terminal_valid") == 0
                and frame == info["length"] - 1
                and frame > info["last_valid"]
            ):
                raise RuntimeError(f"{repo} ep {ep}: outcome_frame {frame} is terminal padding")
            row.update(
                status="confirmed",
                new_outcome=record["new_outcome"],
                outcome_frame=ConvexInt64(frame),
                soft_truncate=bool(record["soft_truncate"]),
            )
            if "subtask_frames" in record:
                row["subtask_frames"] = [ConvexInt64(int(f)) for f in record["subtask_frames"]]
        plan.append(row)
    return plan


def insert_rows(repo: str, rows: list[dict]) -> None:
    args = convex_to_json({"dataset_repo": repo, "hf_sha": PINS[repo][0], "rows": rows})
    proc = subprocess.run(
        ["npx", "convex", "run", "reviews:backfillAppliedRecords", json.dumps(args)],
        cwd=ARENA_DIR,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{repo}: convex run failed ({proc.returncode}):\n{proc.stderr[-4000:]}")
    result = json.loads(proc.stdout)
    if result != {"inserted": len(rows)}:
        raise RuntimeError(f"{repo}: expected {len(rows)} inserts, got {result}")
    print(f"  INSERTED {len(rows)} row(s) on {repo}")


def verify_repo(arena: ConvexClient, repo: str, jobs_before: int) -> None:
    """Every HF record now has a row; no apply job was created."""
    jobs = arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0})
    if len(jobs) != jobs_before:
        raise RuntimeError(f"{repo}: apply job count changed {jobs_before} -> {len(jobs)}")
    sha = PINS[repo][0]
    progress = json.loads(
        Path(
            hf_hub_download(repo, PROGRESS_FILENAME, repo_type="dataset", revision=sha)
        ).read_text()
    )
    hf_eps = {int(e) for e in progress["changed_episodes"]} | set(progress["skipped_episodes"])
    rows = arena.query("reviews:latestForRepo", {"dataset_repo": repo})["episodes"]
    arena_eps = {as_int(row["episode_index"]) for row in rows}
    if hf_eps - arena_eps:
        raise RuntimeError(f"{repo}: still missing rows for {sorted(hf_eps - arena_eps)}")
    mirrors = sum(1 for row in rows if row.get("backfilled_from_hf_sha") == sha)
    print(f"  verified {repo}: {len(rows)} rows cover {len(hf_eps)} HF records ({mirrors} mirrors)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="insert rows (default: dry run)")
    args = parser.parse_args()

    arena = ConvexClient(CONVEX_URL)
    hf = HfApi()
    fs = HfFileSystem()
    plans = {repo: plan_repo(arena, hf, fs, repo) for repo in PINS}
    for repo, rows in plans.items():
        statuses = {s: sum(1 for r in rows if r["status"] == s) for s in ("confirmed", "skipped")}
        saved = sorted(
            {datetime.fromtimestamp(r["saved_at"] / 1000, UTC).isoformat() for r in rows}
        )
        print(f"== {repo} @ {PINS[repo][0]}")
        print(f"   {len(rows)} row(s) to insert {statuses}; saved_at {saved}")
    if not args.apply:
        print("\ndry run; pass --apply to insert")
        return 0
    for repo, rows in plans.items():
        if not rows:
            continue
        jobs_before = len(arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0}))
        insert_rows(repo, rows)
        verify_repo(arena, repo, jobs_before)
    return 0


if __name__ == "__main__":
    sys.exit(main())
