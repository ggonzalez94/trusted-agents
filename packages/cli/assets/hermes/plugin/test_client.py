"""Unit tests for the Hermes tapd client identity resolution (F4.1).

Run directly with::

    python3 -m unittest packages/cli/assets/hermes/plugin/test_client.py

These tests do NOT require a real tapd: they stub ``_http_request`` to
capture which socket path the dispatcher would hit. The goal is to
verify that the per-request identity resolution picks the correct
``dataDir`` (and therefore the correct socket) under each of the four
resolution rules documented in the review:

  1. Explicit ``identity`` param.
  2. No identity + single-entry config.
  3. No identity + zero-entry config (legacy fallback).
  4. No identity + multi-entry config (error).
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

# Import the module under test. The tests tolerate being run both from
# the repo root and from inside the plugin directory.
import importlib
import sys


def _load_client():
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here.parent))
    try:
        module = importlib.import_module("plugin.client")
    except ModuleNotFoundError:
        sys.path.insert(0, str(here))
        module = importlib.import_module("client")
    return module


client = _load_client()


class HermesIdentityResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._hermes_home = tempfile.mkdtemp(prefix="hermes-home-")
        self._legacy_dir = tempfile.mkdtemp(prefix="hermes-legacy-")
        self._primary_dir = tempfile.mkdtemp(prefix="hermes-primary-")
        self._secondary_dir = tempfile.mkdtemp(prefix="hermes-secondary-")
        config_dir = Path(self._hermes_home) / "plugins" / "trusted-agents-tap"
        config_dir.mkdir(parents=True, exist_ok=True)
        self._config_path = config_dir / "config.json"

        self._env_patch = mock.patch.dict(
            os.environ,
            {"HERMES_HOME": self._hermes_home, "TAP_DATA_DIR": self._legacy_dir},
            clear=False,
        )
        self._env_patch.start()

        self._captured: list[dict[str, Any]] = []

        def fake_http_request(
            method: str, path: str, socket_path: Path, body: dict | None = None
        ) -> Any:
            self._captured.append(
                {"method": method, "path": path, "socket": str(socket_path), "body": body}
            )
            return {"ok": True}

        self._http_patch = mock.patch.object(client, "_http_request", side_effect=fake_http_request)
        self._http_patch.start()

    def tearDown(self) -> None:
        self._http_patch.stop()
        self._env_patch.stop()
        import shutil

        for path in (self._hermes_home, self._legacy_dir, self._primary_dir, self._secondary_dir):
            shutil.rmtree(path, ignore_errors=True)

    def _write_config(self, identities: list[dict[str, str]]) -> None:
        self._config_path.write_text(json.dumps({"identities": identities}), encoding="utf-8")

    def _assert_socket_matches_data_dir(self, data_dir: str) -> None:
        self.assertTrue(self._captured, "expected _http_request to be invoked")
        self.assertEqual(
            self._captured[-1]["socket"], str(Path(data_dir) / client.SOCKET_NAME)
        )

    # ── Case 1: explicit identity ──────────────────────────────────────

    def test_explicit_identity_routes_to_named_entry(self) -> None:
        self._write_config(
            [
                {"name": "primary", "dataDir": self._primary_dir},
                {"name": "secondary", "dataDir": self._secondary_dir},
            ]
        )

        result = client.send_request("status", {"identity": "primary"})
        self.assertEqual(result, {"ok": True})
        self._assert_socket_matches_data_dir(self._primary_dir)

        self._captured.clear()
        result = client.send_request("status", {"identity": "secondary"})
        self.assertEqual(result, {"ok": True})
        self._assert_socket_matches_data_dir(self._secondary_dir)

    def test_explicit_identity_not_in_config_errors(self) -> None:
        self._write_config(
            [
                {"name": "primary", "dataDir": self._primary_dir},
                {"name": "secondary", "dataDir": self._secondary_dir},
            ]
        )
        result = client.send_request("status", {"identity": "ghost"})
        self.assertIn("error", result)
        self.assertIn("unknown identity", result["error"])
        self.assertFalse(self._captured, "should not dispatch on identity error")

    # ── Case 2: single-entry config, no identity passed ────────────────

    def test_single_entry_config_without_identity_uses_that_entry(self) -> None:
        self._write_config([{"name": "only", "dataDir": self._primary_dir}])

        result = client.send_request("status", {})
        self.assertEqual(result, {"ok": True})
        self._assert_socket_matches_data_dir(self._primary_dir)

    # ── Case 3: zero-entry config, no identity passed ──────────────────

    def test_zero_entry_config_falls_back_to_tap_data_dir(self) -> None:
        # No config file written → falls back to TAP_DATA_DIR (legacy path).
        result = client.send_request("status", {})
        self.assertEqual(result, {"ok": True})
        self._assert_socket_matches_data_dir(self._legacy_dir)

    def test_zero_entry_config_with_explicit_identity_errors(self) -> None:
        # Even in legacy mode, a passed `identity` is validated.
        result = client.send_request("status", {"identity": "primary"})
        self.assertIn("error", result)
        self.assertFalse(self._captured)

    # ── Case 4: multi-entry config, no identity passed ─────────────────

    def test_multi_entry_config_without_identity_errors(self) -> None:
        self._write_config(
            [
                {"name": "primary", "dataDir": self._primary_dir},
                {"name": "secondary", "dataDir": self._secondary_dir},
            ]
        )
        result = client.send_request("status", {})
        self.assertIn("error", result)
        self.assertIn("multiple", result["error"])
        self.assertFalse(self._captured)

    # ── Bonus: identity is NOT forwarded to tapd as a body field ───────

    def test_identity_param_is_not_forwarded_to_tapd(self) -> None:
        self._write_config([{"name": "only", "dataDir": self._primary_dir}])
        client.send_request("send_message", {"peer": "bob", "text": "hi", "identity": "only"})
        self.assertEqual(len(self._captured), 1)
        body = self._captured[-1]["body"]
        self.assertIsInstance(body, dict)
        self.assertNotIn("identity", body)
        self.assertEqual(body["peer"], "bob")
        self.assertEqual(body["text"], "hi")


class HermesDrainAllIdentitiesTests(unittest.TestCase):
    """Tests for multi-identity notification drain (residual 1).

    ``drain_all_identities`` drains every configured Hermes identity,
    tags notifications with their source identity, and surfaces
    per-identity reachability errors as meta escalations so they are
    never silently lost.
    """

    def setUp(self) -> None:
        self._hermes_home = tempfile.mkdtemp(prefix="hermes-home-")
        self._legacy_dir = tempfile.mkdtemp(prefix="hermes-legacy-")
        self._primary_dir = tempfile.mkdtemp(prefix="hermes-primary-")
        self._secondary_dir = tempfile.mkdtemp(prefix="hermes-secondary-")
        config_dir = Path(self._hermes_home) / "plugins" / "trusted-agents-tap"
        config_dir.mkdir(parents=True, exist_ok=True)
        self._config_path = config_dir / "config.json"

        self._env_patch = mock.patch.dict(
            os.environ,
            {"HERMES_HOME": self._hermes_home, "TAP_DATA_DIR": self._legacy_dir},
            clear=False,
        )
        self._env_patch.start()

        self._responses: dict[str, Any] = {}

        def fake_http_request(
            method: str, path: str, socket_path: Path, body: dict | None = None
        ) -> Any:
            key = str(socket_path)
            if key in self._responses:
                response = self._responses[key]
                if isinstance(response, Exception):
                    return {"error": str(response)}
                return response
            return {"error": f"no fake response for {key}"}

        self._http_patch = mock.patch.object(client, "_http_request", side_effect=fake_http_request)
        self._http_patch.start()

    def tearDown(self) -> None:
        self._http_patch.stop()
        self._env_patch.stop()
        import shutil

        for path in (self._hermes_home, self._legacy_dir, self._primary_dir, self._secondary_dir):
            shutil.rmtree(path, ignore_errors=True)

    def _write_config(self, identities: list[dict[str, str]]) -> None:
        self._config_path.write_text(json.dumps({"identities": identities}), encoding="utf-8")

    def _socket_for(self, data_dir: str) -> str:
        return str(Path(data_dir) / client.SOCKET_NAME)

    def test_zero_identity_config_drains_default_socket(self) -> None:
        # No config file at all (legacy single-agent mode) — drain from
        # TAP_DATA_DIR's default socket. Notifications carry no identity
        # tag, so format_notification_context renders them without a
        # prefix.
        self._responses[self._socket_for(self._legacy_dir)] = {
            "notifications": [{"type": "info", "oneLiner": "only message"}]
        }
        result = client.drain_all_identities()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["oneLiner"], "only message")
        self.assertNotIn("identity", result[0])

    def test_single_identity_config_drains_that_identity_socket(self) -> None:
        self._write_config([{"name": "only", "dataDir": self._primary_dir}])
        self._responses[self._socket_for(self._primary_dir)] = {
            "notifications": [{"type": "info", "oneLiner": "hello"}]
        }
        result = client.drain_all_identities()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["oneLiner"], "hello")
        # Tagged with the identity so the formatter can decide whether
        # to show a prefix.
        self.assertEqual(result[0]["identity"], "only")

    def test_two_identity_config_drains_both_and_merges(self) -> None:
        self._write_config(
            [
                {"name": "primary", "dataDir": self._primary_dir},
                {"name": "secondary", "dataDir": self._secondary_dir},
            ]
        )
        self._responses[self._socket_for(self._primary_dir)] = {
            "notifications": [{"type": "escalation", "oneLiner": "primary alert"}]
        }
        self._responses[self._socket_for(self._secondary_dir)] = {
            "notifications": [{"type": "info", "oneLiner": "secondary info"}]
        }
        result = client.drain_all_identities()
        self.assertEqual(len(result), 2)
        # Config order is preserved.
        self.assertEqual(result[0]["identity"], "primary")
        self.assertEqual(result[0]["oneLiner"], "primary alert")
        self.assertEqual(result[1]["identity"], "secondary")
        self.assertEqual(result[1]["oneLiner"], "secondary info")

    def test_per_identity_failure_surfaces_meta_escalation(self) -> None:
        self._write_config(
            [
                {"name": "primary", "dataDir": self._primary_dir},
                {"name": "secondary", "dataDir": self._secondary_dir},
            ]
        )
        # primary is unreachable, secondary is healthy.
        self._responses[self._socket_for(self._primary_dir)] = {
            "error": "tapd is not running: socket missing"
        }
        self._responses[self._socket_for(self._secondary_dir)] = {
            "notifications": [{"type": "info", "oneLiner": "hi from secondary"}]
        }
        result = client.drain_all_identities()
        self.assertEqual(len(result), 2)
        # First entry: meta escalation for the failed identity.
        self.assertEqual(result[0]["type"], "escalation")
        self.assertEqual(result[0]["identity"], "primary")
        self.assertIn("unable to reach tapd", result[0]["oneLiner"])
        self.assertIn("primary", result[0]["oneLiner"])
        # Second entry: the healthy identity's notification still arrived.
        self.assertEqual(result[1]["identity"], "secondary")
        self.assertEqual(result[1]["oneLiner"], "hi from secondary")

    def test_format_context_omits_identity_prefix_for_single_identity(self) -> None:
        notifications = [
            {"type": "info", "oneLiner": "one", "identity": "only"},
            {"type": "escalation", "oneLiner": "two", "identity": "only"},
        ]
        result = client.format_notification_context(notifications)
        self.assertIsNotNone(result)
        context = result["context"]
        # Single identity → no [only] prefix anywhere in the rendered body.
        self.assertNotIn("[only]", context)
        self.assertIn("- INFO: one", context)
        self.assertIn("- ESCALATION: two", context)

    def test_format_context_adds_identity_prefix_for_multiple_identities(self) -> None:
        notifications = [
            {"type": "info", "oneLiner": "one", "identity": "primary"},
            {"type": "escalation", "oneLiner": "two", "identity": "secondary"},
        ]
        result = client.format_notification_context(notifications)
        self.assertIsNotNone(result)
        context = result["context"]
        self.assertIn("- INFO [primary]: one", context)
        self.assertIn("- ESCALATION [secondary]: two", context)

    def test_format_context_untagged_notification_still_renders_without_prefix(
        self,
    ) -> None:
        # Legacy code path (single-identity, no tag) is unchanged.
        notifications = [{"type": "info", "oneLiner": "no tag"}]
        result = client.format_notification_context(notifications)
        self.assertIsNotNone(result)
        self.assertIn("- INFO: no tag", result["context"])
        self.assertNotIn("[", result["context"].split("[TAP Notifications]")[1])


class HermesLegacyDataDirTests(unittest.TestCase):
    def test_legacy_data_dir_prefers_tap_data_dir_env(self) -> None:
        with mock.patch.dict(os.environ, {"TAP_DATA_DIR": "/tmp/agent-x"}, clear=False):
            self.assertEqual(client._legacy_data_dir(), Path("/tmp/agent-x"))

    def test_legacy_data_dir_falls_back_to_home(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TAP_DATA_DIR", None)
            self.assertEqual(
                client._legacy_data_dir(), Path.home() / ".trustedagents"
            )


if __name__ == "__main__":
    unittest.main()
