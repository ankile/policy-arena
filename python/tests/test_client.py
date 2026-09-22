import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from convex import json_to_convex

from policy_arena import (
    PolicyArenaAPIError,
    PolicyArenaClient,
    PolicyInput,
    RoundInput,
    RoundResultInput,
)


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class PolicyArenaClientTest(unittest.TestCase):
    def test_derives_http_action_url(self):
        client = PolicyArenaClient(
            "https://grandiose-rook-292.convex.cloud", api_key="test.key"
        )
        self.assertEqual(
            client.api_url,
            "https://grandiose-rook-292.convex.site/api/v1",
        )

    def test_write_requires_machine_key(self):
        client = PolicyArenaClient(
            "https://grandiose-rook-292.convex.cloud", api_key=None
        )
        with patch.dict("os.environ", {}, clear=True):
            client.api_key = None
            with self.assertRaisesRegex(
                PolicyArenaAPIError, "POLICY_ARENA_API_KEY is required"
            ):
                client.delete_dataset("ankile/example")

    @patch("policy_arena.client.urlopen")
    def test_submission_sends_auth_and_idempotency_headers(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse(
            {"ok": True, "actor": "pa_test", "value": "session-id"}
        )
        client = PolicyArenaClient(
            "https://grandiose-rook-292.convex.cloud",
            api_key="pa_test.secret",
        )

        result = client.submit_eval_session(
            dataset_repo="ankile/example",
            policies=[PolicyInput("policy", "model", "task")],
            rounds=[
                RoundInput(
                    round_index=0,
                    results=[RoundResultInput("model", True, 3)],
                )
            ],
            session_mode="rollout",
            idempotency_key="fixed-request-id",
        )

        self.assertEqual(result, "session-id")
        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer pa_test.secret")
        self.assertEqual(request.get_header("Idempotency-key"), "fixed-request-id")
        decoded_body = json_to_convex(json.loads(request.data))
        self.assertEqual(decoded_body["rounds"][0]["round_index"].value, 0)
        self.assertEqual(
            decoded_body["rounds"][0]["results"][0]["episode_index"].value,
            3,
        )

    @patch("policy_arena.client.urlopen")
    def test_http_error_is_reported(self, mock_urlopen):
        mock_urlopen.side_effect = HTTPError(
            url="https://example.convex.site/api/v1/admin/delete-dataset",
            code=403,
            msg="Forbidden",
            hdrs=None,
            fp=io.BytesIO(json.dumps({"ok": False, "error": "scope denied"}).encode()),
        )
        client = PolicyArenaClient(
            "https://grandiose-rook-292.convex.cloud",
            api_key="pa_test.secret",
        )

        with self.assertRaisesRegex(PolicyArenaAPIError, "HTTP 403: scope denied"):
            client.delete_dataset("ankile/example")


if __name__ == "__main__":
    unittest.main()
