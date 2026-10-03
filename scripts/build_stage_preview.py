"""Print a versioned local task preview spec; never publish or rewrite labels.

Run with the SIR Python environment and --sir-root /path/to/self-improving-robots.
The frozen Arena fixture supplies only the existing adapter envelope. Task
semantics and the response schema come from the versioned SIR definition.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

TASKS = {
    "routing_d1": ("routing_d1_v1", "v4", ("v2", "v3", "v4")),
    "marker_d2": ("marker_d2_v4", "v6", ("v5", "v6")),
    "square_d2": ("square_d2_v3", "v5", ("v4", "v5")),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sir-root", type=Path, required=True)
    parser.add_argument("--task", choices=TASKS, default="routing_d1")
    parser.add_argument("--version", help="Defaults to the latest local candidate for the selected task")
    parser.add_argument("--check", action="store_true", help="Check the committed preview instead of printing it")
    args = parser.parse_args()
    fixture, default_version, versions = TASKS[args.task]
    version = args.version or default_version
    if version not in versions:
        parser.error(f"Unsupported {args.task} version {version}; choose from {versions}")
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(args.sir_root.resolve()))
    # Load the pure hash codec without importing the network client's SDK.
    codec_spec = importlib.util.spec_from_file_location(
        "prediction_hashes", root / "python/policy_arena/prediction_hashes.py"
    )
    codec = importlib.util.module_from_spec(codec_spec)
    codec_spec.loader.exec_module(codec)
    from sir.real.stage_labeling.trajectory_contract import build_response_schema, load_task_definition

    definition = load_task_definition(
        args.sir_root / f"sir/real/stage_labeling/data/{args.task}_{version}.json"
    )
    fixtures = json.loads((root / "tests/fixtures/trajectory-review-fixtures.json").read_text())
    spec = copy.deepcopy(next(
        task["spec"] for task in fixtures["synthetic"]["tasks"]
        if task["source_name"] == fixture
    ))
    spec.pop("taxonomy_hash")
    spec["taxonomy_version"] = f"trajectory-review/v1/{definition['taxonomyVersion']}"
    spec["ladder"]["success_level"] = min(
        stage["index"] for stage in definition["stages"]
        if stage["id"] in definition["successDefinition"]["successfulStageIds"]
    )
    spec["ladder"]["max_stage"] = max(stage["index"] for stage in definition["stages"])
    spec["ladder"]["levels"] = [
        {
            "sid": stage["index"],
            "text": "\n".join([stage["description"], *stage["entryCriteria"], *stage.get("exclusions", [])]),
            "gate_field": None, "gate_time_field": None, "gate_any_of": [], "gate_all_of": [],
        }
        for stage in definition["stages"]
    ]
    # All editable vocabularies come from the versioned definition, never from
    # the legacy adapter fixture. Its single preferred success state must still
    # be valid; trajectory-aware consumers use the full successDefinition.
    spec["failure_modes"] = [item["id"] for item in definition["failureModes"]]
    spec["final_states"] = [item["id"] for item in definition["finalStates"]]
    if spec["success_final_state"] not in definition["successDefinition"]["successfulFinalStateIds"]:
        raise ValueError("Choose an explicit compatible adapter success_final_state for this revision")
    spec["trajectory"] = {
        "adapter_version": "trajectory-review/v1",
        "task_definition": definition,
        "task_definition_sha256": hashlib.sha256(json.dumps(
            definition, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()).hexdigest(),
        "response_schema": build_response_schema(definition),
    }
    spec["taxonomy_hash"] = codec.canonical_digest(spec)
    if args.check:
        saved = json.loads((root / f"sandbox/data/{args.task}_{version}.spec.json").read_text())
        if saved != spec:
            raise SystemExit(f"{args.task} preview differs from its source definition or response schema")
        print(f"{args.task}/{version} preview matches the SIR definition, generated response schema, and content hashes.")
        return
    print(json.dumps(spec, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
