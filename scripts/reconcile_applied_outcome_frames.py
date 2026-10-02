"""Reconcile Arena outcome reviews with the applied HF progress record.

The apply normalizes an outcome mark placed on an episode's terminal
is_valid=0 padding frame to the last valid frame and writes that to HF
`.outcome_edit_progress.json`. Until 2026-10-01 the review row kept the raw
frame, so `reviews:latestForRepo` drifted from HF by that snap. The worker now
writes the applied frame back (`reviews:recordAppliedOutcomeFrames`); this
script repairs rows applied before that change.

It scans every repo Arena knows (registered datasets, eval sessions, repos
with outcome reviews), eval and collection alike, and compares the Arena fold
against the progress record at HF `main`. A repo with neither rows nor a
progress record has nothing to compare; an HF record without a row (the
cv2-era gap `backfill_missing_review_rows.py` fills) is an issue. On
2026-10-01 every one of the 82 `ankile/*` HF datasets (of 1,118) carrying a
progress record was registered in Arena. A row is patched only when its ONLY
difference is outcome_frame AND the snap rule explains it: the Arena frame is
the episode's terminal frame (length - 1), the HF frame is earlier, and the HF
frame is the episode's last is_valid=1 frame at `main`. Every other
difference is printed and left alone, and the script exits nonzero.
Rows with `backfilled_from_hf_sha` (cv2-era decisions mirrored by
backfill_missing_review_rows.py) are applied by construction, so they are
compared against HF whatever their creation time. An HF record without
`soft_truncate` (written by the 2026-02 editor) compares as soft_truncate=True,
the value both apply implementations use for a missing key.

Patches go through `npx convex run` against the dev deployment
(grandiose-rook-292), the same internal mutation the apply worker calls.

Run from the sir repo root (needs huggingface_hub + pyarrow + convex):
  uv run python deps/policy_arena/scripts/reconcile_applied_outcome_frames.py          # dry run
  uv run python deps/policy_arena/scripts/reconcile_applied_outcome_frames.py --apply
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pyarrow.parquet as pq
from convex import ConvexClient, ConvexInt64, convex_to_json
from huggingface_hub import HfApi, HfFileSystem, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError

CONVEX_URL = "https://grandiose-rook-292.convex.cloud"
ARENA_DIR = Path(__file__).resolve().parents[1]
PROGRESS_FILENAME = ".outcome_edit_progress.json"
RECORD_KEYS = {"new_outcome", "outcome_frame", "soft_truncate", "subtask_frames"}


def as_int(value) -> int:
    return int(value.value) if isinstance(value, ConvexInt64) else int(value)


@dataclass
class RepoReport:
    repo: str
    sha: str | None = None
    has_progress: bool = True
    records: int = 0
    rows: int = 0
    matched: int = 0
    patches: list[dict] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)


def arena_record(row: dict) -> dict:
    """The progress record the apply builds from a review row (buildOverlay)."""
    record = {
        "new_outcome": row["new_outcome"],
        "outcome_frame": as_int(row["outcome_frame"]),
        "soft_truncate": bool(row.get("soft_truncate", False)),
    }
    if row.get("subtask_frames") is not None:
        record["subtask_frames"] = sorted({as_int(f) for f in row["subtask_frames"]})
    return record


def episode_frames(fs: HfFileSystem, repo: str, sha: str, episodes: set[int]) -> dict[int, dict]:
    """length, terminal frame and last is_valid=1 frame at `sha` for `episodes`."""
    root = f"datasets/{repo}@{sha}"
    meta_cols = ["episode_index", "length", "data/chunk_index", "data/file_index"]
    files: dict[str, set[int]] = {}
    lengths: dict[int, int] = {}
    for path in sorted(fs.glob(f"{root}/meta/episodes/**/*.parquet")):
        with fs.open(path, "rb") as fh:
            meta = pq.read_table(fh, columns=meta_cols).to_pylist()
        for row in meta:
            ep = int(row["episode_index"])
            if ep not in episodes:
                continue
            lengths[ep] = int(row["length"])
            data = (
                f"{root}/data/chunk-{int(row['data/chunk_index']):03d}/"
                f"file-{int(row['data/file_index']):03d}.parquet"
            )
            files.setdefault(data, set()).add(ep)
    missing = episodes - lengths.keys()
    if missing:
        raise RuntimeError(f"{repo}@{sha}: episodes {sorted(missing)} absent from meta/episodes")
    out: dict[int, dict] = {}
    for path, eps in sorted(files.items()):
        with fs.open(path, "rb") as fh:
            schema_names = pq.read_schema(fh).names
        if "is_valid" not in schema_names:
            raise RuntimeError(f"{path}: no is_valid column; outcome frames are never normalized")
        with fs.open(path, "rb") as fh:
            table = pq.read_table(
                fh,
                columns=["episode_index", "frame_index", "is_valid"],
                filters=[("episode_index", "in", sorted(eps))],
            ).to_pydict()
        by_ep: dict[int, list[tuple[int, int]]] = {}
        for ep, frame, valid in zip(
            table["episode_index"], table["frame_index"], table["is_valid"], strict=True
        ):
            by_ep.setdefault(int(ep), []).append((int(frame), int(valid)))
        for ep in eps:
            frames = sorted(by_ep[ep])
            if len(frames) != lengths[ep] or [f for f, _ in frames] != list(range(lengths[ep])):
                raise RuntimeError(
                    f"{path}: episode {ep} frames do not match meta length {lengths[ep]}"
                )
            out[ep] = {
                "length": lengths[ep],
                "terminal": frames[-1][0],
                "terminal_valid": frames[-1][1],
                "last_valid": max(f for f, valid in frames if valid == 1),
            }
    return out


def reconcile_repo(arena: ConvexClient, hf: HfApi, fs: HfFileSystem, repo: str) -> RepoReport:
    report = RepoReport(repo)
    jobs = arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0})
    active = [j for j in jobs if j["status"] in ("pending", "applying")]
    if active:
        report.issues.append(f"apply job {active[0]['_id']} is {active[0]['status']}; repo skipped")
        return report
    applied = [j for j in jobs if j["status"] == "applied"]
    cutoff = max((float(j["started_at"]) for j in applied), default=None)

    report.sha = hf.repo_info(repo, repo_type="dataset", revision="main").sha
    try:
        progress_path = hf_hub_download(
            repo, PROGRESS_FILENAME, repo_type="dataset", revision=report.sha
        )
    except EntryNotFoundError:
        progress_path = None
    rows = arena.query("reviews:latestForRepo", {"dataset_repo": repo})["episodes"]
    report.rows = len(rows)
    if progress_path is None:
        report.has_progress = False
        if rows:
            report.issues.append(f"{len(rows)} review row(s) but no {PROGRESS_FILENAME} at main")
        return report
    progress = json.loads(Path(progress_path).read_text())
    changed: dict[str, dict] = progress["changed_episodes"]
    skipped = {int(e) for e in progress["skipped_episodes"]}
    report.records = len(changed) + len(skipped)
    candidates: dict[int, dict] = {}
    arena_eps: set[int] = set()
    for row in rows:
        ep = as_int(row["episode_index"])
        arena_eps.add(ep)
        tag = f"ep {ep} ({row['status']} by {row['reviewer']})"
        mirror = row.get("backfilled_from_hf_sha") is not None
        if not mirror and (cutoff is None or float(row["_creationTime"]) > cutoff):
            report.issues.append(f"{tag}: unapplied (saved after the last applied job claim)")
            continue
        if row["status"] == "skipped":
            if ep in skipped and str(ep) not in changed:
                report.matched += 1
            else:
                report.issues.append(f"{tag}: HF has {changed.get(str(ep))!r}, not a skip")
            continue
        mine = arena_record(row)
        theirs = changed.get(str(ep))
        if theirs is None:
            where = "in skipped_episodes" if ep in skipped else "absent"
            report.issues.append(f"{tag}: HF record {where}; Arena {mine}")
            continue
        if set(theirs) - RECORD_KEYS:
            report.issues.append(
                f"{tag}: HF record has unexpected keys {sorted(set(theirs) - RECORD_KEYS)}"
            )
            continue
        rest_mine = {k: v for k, v in mine.items() if k != "outcome_frame"}
        rest_theirs = {k: v for k, v in theirs.items() if k != "outcome_frame"}
        rest_theirs.setdefault("soft_truncate", True)  # the apply default for a missing key
        if rest_mine != rest_theirs:
            report.issues.append(f"{tag}: non-frame drift Arena {mine} vs HF {theirs}")
            continue
        if mine["outcome_frame"] == theirs["outcome_frame"]:
            report.matched += 1
            continue
        candidates[ep] = {
            "review_id": row["_id"],
            "raw": mine["outcome_frame"],
            "hf": int(theirs["outcome_frame"]),
            "tag": tag,
        }
    hf_only = sorted(({int(e) for e in changed} | skipped) - arena_eps)
    if hf_only:
        report.issues.append(
            f"{len(hf_only)} HF progress record(s) without an Arena review: {hf_only}"
        )

    if candidates:
        frames = episode_frames(fs, repo, report.sha, set(candidates))
        for ep, cand in sorted(candidates.items()):
            info = frames[ep]
            snap = (
                cand["raw"] == info["terminal"] == info["length"] - 1
                and info["terminal_valid"] == 0
                and cand["hf"] < cand["raw"]
                and cand["hf"] == info["last_valid"]
            )
            if snap:
                report.patches.append(
                    {
                        "review_id": cand["review_id"],
                        "episode": ep,
                        "raw": cand["raw"],
                        "hf": cand["hf"],
                    }
                )
            else:
                report.issues.append(
                    f"{cand['tag']}: outcome_frame Arena {cand['raw']} vs HF {cand['hf']} is not a "
                    f"terminal-padding snap (length {info['length']}, last valid {info['last_valid']}, "
                    f"terminal is_valid {info['terminal_valid']})"
                )
    return report


def apply_patches(report: RepoReport) -> None:
    args = convex_to_json(
        {
            "dataset_repo": report.repo,
            "applied": [
                {"review_id": p["review_id"], "outcome_frame": ConvexInt64(p["hf"])}
                for p in report.patches
            ],
        }
    )
    proc = subprocess.run(
        ["npx", "convex", "run", "reviews:recordAppliedOutcomeFrames", json.dumps(args)],
        cwd=ARENA_DIR,
        capture_output=True,
        text=True,
        check=True,
    )
    result = json.loads(proc.stdout)
    if result["patched"] != len(report.patches) or result["superseded"]:
        raise RuntimeError(f"{report.repo}: expected {len(report.patches)} patches, got {result}")
    print(f"  PATCHED {result['patched']} row(s) on {report.repo}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="patch rows (default: dry run)")
    args = parser.parse_args()

    arena = ConvexClient(CONVEX_URL)
    hf = HfApi()
    fs = HfFileSystem()
    reviewed = set(arena.query("reviews:reviewedRepos", {}))
    sessions = {s["dataset_repo"] for s in arena.query("evalSessions:list", {})}
    datasets = {d["repo_id"] for d in arena.query("datasets:list", {})}
    repos = sorted(reviewed | sessions | datasets)
    print(
        f"{len(repos)} repo(s): {len(datasets)} registered datasets, {len(sessions)} with an "
        f"eval session, {len(reviewed)} with outcome reviews "
        f"({'APPLY' if args.apply else 'dry run'})"
    )
    reports = [reconcile_repo(arena, hf, fs, repo) for repo in repos]

    bare = [r for r in reports if not r.has_progress and not r.rows and not r.issues]
    print(f"{len(bare)} repo(s) have neither a progress record nor review rows")
    for report in reports:
        if report in bare:
            continue
        print(f"\n== {report.repo} @ main {report.sha}")
        print(
            f"   {report.records} HF record(s), {report.rows} latest row(s): "
            f"{report.matched} match HF, "
            f"{len(report.patches)} frame snap(s) to patch, {len(report.issues)} issue(s)"
        )
        for patch in report.patches:
            print(f"   snap ep {patch['episode']}: Arena {patch['raw']} -> HF {patch['hf']}")
        for issue in report.issues:
            print(f"   ISSUE {issue}")

    total_patches = sum(len(r.patches) for r in reports)
    total_issues = sum(len(r.issues) for r in reports)
    print(f"\nTOTAL: {total_patches} row(s) to patch, {total_issues} issue(s) left alone")
    if args.apply:
        for report in reports:
            if report.patches:
                apply_patches(report)
    return 1 if total_issues else 0


if __name__ == "__main__":
    sys.exit(main())
