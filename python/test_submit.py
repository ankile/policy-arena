"""Smoke test: submit a fake eval session to Policy Arena and verify it on the leaderboard."""

import sys

from policy_arena import PolicyArenaClient, PolicyInput, RoundInput, RoundResultInput

ARENA_URL = "https://grandiose-rook-292.convex.cloud"


def main():
    client = PolicyArenaClient(ARENA_URL)

    # Build fake eval data with two policies and two rounds
    policies = [
        PolicyInput(
            name="smoke-test-policy-A",
            model_id="wandb://test/smoke/policy-a:v0",
            environment="smoke_test",
        ),
        PolicyInput(
            name="smoke-test-policy-B",
            model_id="wandb://test/smoke/policy-b:v0",
            environment="smoke_test",
        ),
    ]

    rounds = [
        RoundInput(
            round_index=0,
            results=[
                RoundResultInput(model_id="wandb://test/smoke/policy-a:v0", success=True, episode_index=0),
                RoundResultInput(model_id="wandb://test/smoke/policy-b:v0", success=False, episode_index=1),
            ],
        ),
        RoundInput(
            round_index=1,
            results=[
                RoundResultInput(model_id="wandb://test/smoke/policy-a:v0", success=True, episode_index=2),
                RoundResultInput(model_id="wandb://test/smoke/policy-b:v0", success=True, episode_index=3),
            ],
        ),
    ]

    print("Submitting fake eval session...")
    session_id = client.submit_eval_session(
        dataset_repo="test/smoke-test-dataset",
        policies=policies,
        rounds=rounds,
        notes="Smoke test submission",
    )
    print(f"Session submitted: {session_id}")

    # Verify the policies appear on the leaderboard
    leaderboard = client.get_leaderboard()
    smoke_policies = [p for p in leaderboard if p.get("environment") == "smoke_test"]
    print(f"\nLeaderboard entries for 'smoke_test' environment: {len(smoke_policies)}")
    for p in smoke_policies:
        print(f"  {p['name']}: elo={p['elo']}, W={p['wins']}/L={p['losses']}/D={p['draws']}")

    if smoke_policies:
        print("\nSmoke test PASSED")
    else:
        print("\nWARNING: No smoke_test entries found on leaderboard (may need time to propagate)")
        sys.exit(1)


if __name__ == "__main__":
    main()
