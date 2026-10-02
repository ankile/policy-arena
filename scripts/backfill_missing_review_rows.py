"""Backfill Arena review rows for pre-web outcome decisions already on HF.

Many eval and collection (teleop/DAgger) datasets were outcome-reviewed with
the local cv2 editor (`sir/tools/outcome_editor.py`) before the web review
flow existed: their HF
`.outcome_edit_progress.json` holds the decisions but Arena has no review row
(or only rows for the episodes later re-reviewed on the web). This script
inserts one row per HF record that has no row, so the Arena fold
(`reviews:latestForRepo`) equals the HF record for every reviewed episode.

Workflow (run from the sir repo root):
  # dry run over a repo list (one repo id per line); records each repo's HF
  # main sha and gap size in a pins file
  uv run python deps/policy_arena/scripts/backfill_missing_review_rows.py \
      --repos-file repos.txt --write-pins pins.json
  # insert, refusing any repo whose HF main or gap moved since the dry run
  uv run python deps/policy_arena/scripts/backfill_missing_review_rows.py \
      --pins pins.json --apply

Committed pins files under `scripts/review_backfill_pins/` record what was
backfilled. The first two repos (md2 R5 repeat @ ccf86378, 148 rows; 01c
blind-eval r1 @ eff17de8, 78 rows) predate the pins files; see this script's
git history (8b7669b, 24b5e0b).

Attribution, per missing episode, from two independent sources at the pinned
sha:

1. HF commit archaeology. Walk the dataset's commits up to the pin and find the
   landing commit: the first commit of the final unchanged run of the
   episode's progress-record state (changed record / skipped). That commit is
   when the current decision reached HF.
2. `.label_history.jsonl`. The 2026-08-19 label-history bootstrap reconstructed
   cv2-era outcome events from the same commit archaeology, so `ts` is the time
   of the HF commit that carried the cv2 progress record (not the keystroke
   time) and `evidence.post_sha` is that commit.

With an event (the newest outcome event for the episode): it must be
`{kind: human, agent: ankile, tool: cv2-editor}`, its payload must equal the HF
record (`{"action": "skip"}` for skips), its `evidence.post_sha` must be the
landing commit and its `ts` that commit's time. Any disagreement is a
contradiction and aborts the whole run. The row takes reviewer = the event's
agent, saved_at = its ts, source_tool = CV2_SOURCE_TOOL.

Without an event (no history file, or none for that episode): the landing
commit is the only evidence. The row takes reviewer = that commit's sole HF
author (the account that pushed the decision, the only identity on record;
more than one author aborts), saved_at = the commit time, and a source_tool
that says the editor was not recorded and names the commit. On 2026-10-01 no
repo needed this: for all 9,088 episodes backfilled that day (43 eval repos,
5,350 rows; 29 teleop/DAgger collection parents, 3,738 rows) the event agreed
with the landing commit to the second and sha.

Record mirroring: changed -> `confirmed` with new_outcome / outcome_frame /
soft_truncate, and subtask_frames only when the record has that key; skipped ->
`skipped` with no outcome fields. A record without `soft_truncate` (the
2026-02 editor did not write it) gets soft_truncate=True, the value both apply
implementations use for a missing key (`info.get("soft_truncate", True)` in
`apply_outcome_edits`, `?? true` in convex/apply/frames.ts), so a later apply
over the row produces the same data. When the data has is_valid, every frame
after outcome_frame must be is_valid=0 (the data was truncated), else the run
aborts.

Rows go through the internal mutation `reviews:backfillAppliedRecords` (via
`npx convex run` against grandiose-rook-292, in chunks of CHUNK rows). It
stamps `backfilled_from_hf_sha`, refuses episodes whose newest row is live and
repos with an active apply job, and does NOT enqueue an apply: the decisions
are already on HF. The freshness gate (`sir.real.lifecycle.arena_freshness`)
and `reconcile_applied_outcome_frames.py` treat these rows as applied, and
`reviews:save` refuses to clear them.

Guards, all checked for every repo before anything is written: HF `main` is
the pinned sha; no apply job is pending/applying; the gap has the pinned size;
the attribution checks above; each outcome_frame is inside the episode.

An outcome_frame on the terminal is_valid=0 padding frame is mirrored as HF
has it and listed in the pins file (`terminal_padding_episodes`). Such
records predate the editor's 2026-06-11 valid-frame normalization
(117c5ce2c in the sir repo); a later apply would snap the frame to the last
valid frame on HF and write it back onto the row
(`reviews:recordAppliedOutcomeFrames`), so row and record stay equal.
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pyarrow.parquet as pq
from convex import ConvexClient, ConvexInt64, convex_to_json
from huggingface_hub import HfApi, HfFileSystem, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError

CONVEX_URL = "https://grandiose-rook-292.convex.cloud"
ARENA_DIR = Path(__file__).resolve().parents[1]
PROGRESS_FILENAME = ".outcome_edit_progress.json"
HISTORY_FILENAME = ".label_history.jsonl"
CV2_SOURCE = {"kind": "human", "agent": "ankile", "tool": "cv2-editor"}
BACKFILL = (
    "row backfilled from the HF progress record by "
    "policy_arena/scripts/backfill_missing_review_rows.py"
)
CV2_SOURCE_TOOL = f"cv2-editor (sir/tools/outcome_editor.py); {BACKFILL}"
RECORD_KEYS = {"new_outcome", "outcome_frame", "soft_truncate", "subtask_frames"}
CHUNK = 100


def as_int(value) -> int:
    return int(value.value) if isinstance(value, ConvexInt64) else int(value)


def episode_frames(fs: HfFileSystem, repo: str, sha: str, episodes: set[int]) -> dict[int, dict]:
    """length, and (when the data has is_valid) the per-frame validity."""
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
    paths = sorted(files)
    with ThreadPoolExecutor(16) as pool:  # one small parquet file per request
        blobs = dict(zip(paths, pool.map(fs.cat_file, paths), strict=True))
    for path in paths:
        eps = files[path]
        parquet = pq.ParquetFile(io.BytesIO(blobs[path]))
        if "is_valid" not in parquet.schema_arrow.names:
            continue  # no is_valid: apply normalization is the identity
        table = parquet.read(columns=["episode_index", "frame_index", "is_valid"]).to_pydict()
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
            out[ep]["valid"] = [valid for _, valid in frames]
    return out


def read_progress(repo: str, revision: str) -> dict | None:
    try:
        path = hf_hub_download(repo, PROGRESS_FILENAME, repo_type="dataset", revision=revision)
    except EntryNotFoundError:
        return None
    return json.loads(Path(path).read_text())


def record_state(progress: dict | None, ep: int) -> tuple:
    """The episode's progress-record state: changed record, skip, or absent."""
    if progress is None:
        return ("absent",)
    record = progress["changed_episodes"].get(str(ep))
    if record is not None:
        return ("changed", json.dumps(record, sort_keys=True))
    if ep in {int(e) for e in progress["skipped_episodes"]}:
        return ("skipped",)
    return ("absent",)


def landing_commits(hf: HfApi, repo: str, sha: str, episodes: list[int]) -> dict[int, object]:
    """Per episode, the first commit of the final unchanged run of its record state."""
    commits = list(reversed(hf.list_repo_commits(repo, repo_type="dataset", revision=sha)))
    if commits[-1].commit_id != sha:
        raise RuntimeError(f"{repo}: commit walk ends at {commits[-1].commit_id}, not {sha}")
    progresses = [read_progress(repo, c.commit_id) for c in commits]
    out = {}
    for ep in episodes:
        final = record_state(progresses[-1], ep)
        i = len(commits) - 1
        while i > 0 and record_state(progresses[i - 1], ep) == final:
            i -= 1
        out[ep] = commits[i]
    return out


def read_history(repo: str, sha: str) -> list[dict] | None:
    try:
        path = hf_hub_download(repo, HISTORY_FILENAME, repo_type="dataset", revision=sha)
    except EntryNotFoundError:
        return None
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


def plan_repo(
    arena: ConvexClient,
    hf: HfApi,
    fs: HfFileSystem,
    repo: str,
    pin: dict | None,
) -> tuple[dict, list[dict]]:
    """(pin, rows to insert) for `repo`, after every guard passes.

    `pin` None = dry run from a repo list: record the current main sha and gap.
    """
    main = hf.repo_info(repo, repo_type="dataset", revision="main").sha
    if pin is not None and main != pin["hf_sha"]:
        raise RuntimeError(f"{repo}: HF main moved {pin['hf_sha']} -> {main}; re-run the dry run")
    sha = main
    jobs = arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0})
    active = [j for j in jobs if j["status"] in ("pending", "applying")]
    if active:
        raise RuntimeError(f"{repo}: apply job {active[0]['_id']} is {active[0]['status']}")

    progress = read_progress(repo, sha)
    if progress is None:
        raise RuntimeError(f"{repo}@{sha}: no {PROGRESS_FILENAME}; nothing to mirror")
    changed: dict[str, dict] = progress["changed_episodes"]
    skipped = [int(e) for e in progress["skipped_episodes"]]
    if len(set(skipped)) != len(skipped) or {int(e) for e in changed} & set(skipped):
        raise RuntimeError(f"{repo}: progress record lists an episode twice")
    hf_eps = {int(e) for e in changed} | set(skipped)

    rows = arena.query("reviews:latestForRepo", {"dataset_repo": repo})["episodes"]
    arena_eps = {as_int(row["episode_index"]) for row in rows}
    missing = sorted(hf_eps - arena_eps)
    if pin is not None and len(missing) != pin["missing"]:
        raise RuntimeError(f"{repo}: {len(missing)} records without a row, pinned {pin['missing']}")
    new_pin = {"repo": repo, "hf_sha": sha, "missing": len(missing)}
    if not missing:
        return new_pin, []

    landing = landing_commits(hf, repo, sha, missing)
    events = read_history(repo, sha)
    newest: dict[int, dict] = {}
    if events is not None:
        outcome_events = [e for e in events if e["label_kind"] == "outcome"]
        stamps = [e["ts"] for e in outcome_events]
        if stamps != sorted(stamps):
            raise RuntimeError(f"{repo}: label-history outcome events are not in time order")
        for event in outcome_events:
            newest[int(event["episode_index"])] = event

    frames = episode_frames(fs, repo, sha, {ep for ep in missing if str(ep) in changed})
    plan = []
    for ep in missing:
        record = changed.get(str(ep))
        commit = landing[ep]
        if record_state(progress, ep) == ("absent",):
            raise RuntimeError(f"{repo} ep {ep}: not in the progress record")
        event = newest.get(ep)
        if event is not None:
            want = {"action": "skip"} if record is None else record
            if event["source"] != CV2_SOURCE:
                raise RuntimeError(
                    f"{repo} ep {ep}: newest event source {event['source']} is not cv2"
                )
            if event["payload"] != want:
                raise RuntimeError(f"{repo} ep {ep}: event {event['payload']} != HF {want}")
            post_sha = event["evidence"]["post_sha"]
            lag = abs(
                datetime.fromisoformat(event["ts"]).timestamp() - commit.created_at.timestamp()
            )
            if post_sha != commit.commit_id or lag >= 1.0:
                raise RuntimeError(
                    f"{repo} ep {ep}: event ({event['ts']}, post_sha {post_sha}) disagrees with "
                    f"the landing commit ({commit.created_at.isoformat()}, {commit.commit_id})"
                )
            row = {
                "reviewer": event["source"]["agent"],
                "source_tool": CV2_SOURCE_TOOL,
                "saved_at": datetime.fromisoformat(event["ts"]).timestamp() * 1000.0,
            }
            attribution = "cv2-event"
        else:
            if len(commit.authors) != 1:
                raise RuntimeError(
                    f"{repo} ep {ep}: no label-history event and landing commit "
                    f"{commit.commit_id} has authors {commit.authors}"
                )
            row = {
                "reviewer": commit.authors[0],
                "source_tool": (
                    "editor not recorded (no .label_history.jsonl outcome event; decision "
                    f"landed in HF commit {commit.commit_id}); {BACKFILL}"
                ),
                "saved_at": commit.created_at.timestamp() * 1000.0,
            }
            attribution = "commit-only"
        row["episode_index"] = ConvexInt64(ep)
        if record is None:
            row["status"] = "skipped"
        else:
            if set(record) - RECORD_KEYS:
                raise RuntimeError(f"{repo} ep {ep}: unexpected record keys {sorted(record)}")
            frame = int(record["outcome_frame"])
            info = frames[ep]
            if not 0 <= frame < info["length"]:
                raise RuntimeError(
                    f"{repo} ep {ep}: outcome_frame {frame} outside {info['length']}"
                )
            valid = info.get("valid")
            if valid is not None and valid[-1] == 0 and frame == info["length"] - 1:
                last_valid = max(i for i, v in enumerate(valid) if v == 1)
                if frame > last_valid:
                    # Pre-normalization record (the editor snaps such marks to the
                    # last valid frame only since 2026-06-11): mirror it as HF has
                    # it; a later apply snaps both and writes the frame back.
                    row["_padding"] = True
            if "soft_truncate" in record:
                soft_truncate = bool(record["soft_truncate"])
            else:
                soft_truncate = True  # the apply default for a missing key
                if valid is not None and any(valid[frame + 1 :]):
                    raise RuntimeError(
                        f"{repo} ep {ep}: record has no soft_truncate (apply default True) "
                        f"but frames after {frame} are is_valid=1"
                    )
                attribution += "+soft_truncate-default"
            row.update(
                status="confirmed",
                new_outcome=record["new_outcome"],
                outcome_frame=ConvexInt64(frame),
                soft_truncate=soft_truncate,
            )
            if "subtask_frames" in record:
                row["subtask_frames"] = [ConvexInt64(int(f)) for f in record["subtask_frames"]]
        row["_attribution"] = attribution
        plan.append(row)
    return new_pin, plan


def insert_rows(repo: str, sha: str, rows: list[dict]) -> None:
    for start in range(0, len(rows), CHUNK):
        chunk = [
            {k: v for k, v in r.items() if not k.startswith("_")}
            for r in rows[start : start + CHUNK]
        ]
        args = convex_to_json({"dataset_repo": repo, "hf_sha": sha, "rows": chunk})
        proc = subprocess.run(
            ["npx", "convex", "run", "reviews:backfillAppliedRecords", json.dumps(args)],
            cwd=ARENA_DIR,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"{repo}: convex run failed ({proc.returncode}) at rows {start}+:\n"
                f"{proc.stderr[-4000:]}"
            )
        result = json.loads(proc.stdout)
        if result != {"inserted": len(chunk)}:
            raise RuntimeError(f"{repo}: expected {len(chunk)} inserts, got {result}")
    print(f"  INSERTED {len(rows)} row(s) on {repo}")


def verify_repo(arena: ConvexClient, repo: str, sha: str, jobs_before: int, inserted: int) -> None:
    """Every HF record now has a row; no apply job was created."""
    jobs = arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0})
    if len(jobs) != jobs_before:
        raise RuntimeError(f"{repo}: apply job count changed {jobs_before} -> {len(jobs)}")
    progress = read_progress(repo, sha)
    hf_eps = {int(e) for e in progress["changed_episodes"]} | {
        int(e) for e in progress["skipped_episodes"]
    }
    rows = arena.query("reviews:latestForRepo", {"dataset_repo": repo})["episodes"]
    arena_eps = {as_int(row["episode_index"]) for row in rows}
    if hf_eps - arena_eps:
        raise RuntimeError(f"{repo}: still missing rows for {sorted(hf_eps - arena_eps)}")
    mirrors = sum(1 for row in rows if row.get("backfilled_from_hf_sha") == sha)
    if mirrors != inserted:
        raise RuntimeError(f"{repo}: {mirrors} rows carry sha {sha}, inserted {inserted}")
    print(f"  verified {repo}: {len(rows)} rows cover {len(hf_eps)} HF records ({mirrors} mirrors)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--repos-file", type=Path, help="dry run: one repo id per line")
    source.add_argument("--pins", type=Path, help="pins file written by a dry run")
    parser.add_argument("--write-pins", type=Path, help="with --repos-file: write the pins here")
    parser.add_argument("--apply", action="store_true", help="insert rows (needs --pins)")
    args = parser.parse_args()
    if args.apply and args.pins is None:
        parser.error("--apply needs --pins from a dry run")
    if args.write_pins is not None and args.repos_file is None:
        parser.error("--write-pins needs --repos-file")

    if args.repos_file is not None:
        repos = [line.strip() for line in args.repos_file.read_text().splitlines() if line.strip()]
        pins: dict[str, dict | None] = dict.fromkeys(repos)
    else:
        pins = {p["repo"]: p for p in json.loads(args.pins.read_text())}
    if len(pins) == 0:
        raise RuntimeError("no repos given")

    arena = ConvexClient(CONVEX_URL)
    hf = HfApi()
    fs = HfFileSystem()
    plans: dict[str, tuple[dict, list[dict]]] = {}
    for repo, pin in pins.items():
        plans[repo] = plan_repo(arena, hf, fs, repo, pin)
        print(f"planned {repo}: {len(plans[repo][1])} row(s)", file=sys.stderr, flush=True)
    out_pins = []
    for repo, (pin, rows) in plans.items():
        statuses = Counter(r["status"] for r in rows)
        attributions = Counter(r["_attribution"] for r in rows)
        saved = sorted(
            {datetime.fromtimestamp(r["saved_at"] / 1000, UTC).isoformat() for r in rows}
        )
        pin = {
            **pin,
            "confirmed": statuses["confirmed"],
            "skipped": statuses["skipped"],
            "attribution": dict(sorted(attributions.items())),
            "reviewers": sorted({r["reviewer"] for r in rows}),
            "terminal_padding_episodes": [
                as_int(r["episode_index"]) for r in rows if r.get("_padding")
            ],
            "saved_at": saved,
        }
        out_pins.append(pin)
        print(f"== {repo} @ {pin['hf_sha']}")
        print(
            f"   {len(rows)} row(s) to insert ({pin['confirmed']} confirmed, {pin['skipped']} "
            f"skipped); attribution {pin['attribution']}; reviewers {pin['reviewers']}; "
            f"saved_at {saved}"
        )
        if pin["terminal_padding_episodes"]:
            print(f"   outcome_frame on terminal padding: eps {pin['terminal_padding_episodes']}")
    total = sum(len(rows) for _, rows in plans.values())
    print(f"\nTOTAL: {total} row(s) across {sum(1 for _, r in plans.values() if r)} repo(s)")
    if args.write_pins is not None:
        args.write_pins.write_text(json.dumps(out_pins, indent=1) + "\n")
        print(f"pins written to {args.write_pins}")
    if not args.apply:
        print("dry run; pass --pins <file> --apply to insert")
        return 0
    for repo, (pin, rows) in plans.items():
        if not rows:
            continue
        jobs_before = len(arena.query("applyJobs:forRepo", {"dataset_repo": repo, "limit": 1000.0}))
        insert_rows(repo, pin["hf_sha"], rows)
        verify_repo(arena, repo, pin["hf_sha"], jobs_before, len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
