"""HTTP client over Unix socket for the local tapd daemon.

Identity resolution (F4.1)
--------------------------

Hermes supports multiple TAP identities registered via ``tap hermes
configure``, each pinned to its own ``dataDir``. Each ``dataDir`` hosts
its own ``.tapd.sock`` and talks to a different ``TapMessagingService``.
This client reads the Hermes plugin config on every request and picks
the target identity's socket:

  1. Explicit ``identity`` in params: must match a config entry by name.
  2. No ``identity`` passed, config has exactly one entry: use it.
  3. No ``identity`` passed, config has zero entries: fall back to
     ``$TAP_DATA_DIR`` / ``~/.trustedagents`` (legacy single-agent path).
  4. No ``identity`` passed, config has two or more entries: error out.

The config lives at ``<HERMES_HOME>/plugins/trusted-agents-tap/config.json``.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from typing import Any
from urllib.parse import quote

SOCKET_NAME = ".tapd.sock"
DEFAULT_TIMEOUT_SECONDS = 10.0
DAEMON_START_TIMEOUT_SECONDS = 5.0
DAEMON_START_POLL_SECONDS = 0.1
DEFAULT_RECOVERY_GUIDANCE = "Run `tap daemon start` to launch tapd."


class _UnixHTTPConnection(HTTPConnection):
    """HTTPConnection subclass that connects via a Unix domain socket."""

    def __init__(self, socket_path: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:  # type: ignore[override]
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


def _legacy_data_dir() -> Path:
    """Data dir used when no Hermes plugin config entries are present."""
    env_dir = os.environ.get("TAP_DATA_DIR")
    if env_dir and env_dir.strip():
        return Path(env_dir)
    return Path.home() / ".trustedagents"


def _hermes_home() -> Path:
    env_home = os.environ.get("HERMES_HOME")
    if env_home and env_home.strip():
        return Path(env_home)
    return Path.home() / ".hermes"


def _hermes_config_path() -> Path:
    return _hermes_home() / "plugins" / "trusted-agents-tap" / "config.json"


def _load_hermes_identities() -> list[dict[str, Any]]:
    """Read the Hermes plugin config and return the list of identities.

    Returns an empty list if the config file doesn't exist or has no
    identities. Any parse failure raises; callers handle it as a
    structured error back to the agent."""
    config_path = _hermes_config_path()
    try:
        raw = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise RuntimeError(f"failed to read Hermes plugin config at {config_path}: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Hermes plugin config is not valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("Hermes plugin config must be an object")
    identities = parsed.get("identities") or []
    if not isinstance(identities, list):
        raise RuntimeError("Hermes plugin config.identities must be a list")
    normalized: list[dict[str, Any]] = []
    for entry in identities:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        data_dir = entry.get("dataDir")
        if isinstance(name, str) and isinstance(data_dir, str) and data_dir.strip():
            normalized.append({"name": name, "dataDir": data_dir})
    return normalized


def _resolve_target_data_dir(identity: str | None) -> tuple[Path | None, str | None]:
    """Pick a tapd data dir for this request.

    Returns ``(data_dir, error)``. ``error`` is a user-facing message if
    the identity couldn't be resolved; ``data_dir`` is ``None`` in that
    case. On success, ``data_dir`` is a Path and ``error`` is ``None``.
    """
    try:
        identities = _load_hermes_identities()
    except RuntimeError as exc:
        return None, str(exc)

    if identity is not None:
        if not isinstance(identity, str) or not identity.strip():
            return None, "`identity` must be a non-empty string"
        match = next((entry for entry in identities if entry["name"] == identity), None)
        if not match:
            known = ", ".join(entry["name"] for entry in identities) or "(none configured)"
            return None, f"unknown identity: {identity} (known: {known})"
        return Path(match["dataDir"]), None

    if len(identities) == 1:
        return Path(identities[0]["dataDir"]), None

    if len(identities) == 0:
        return _legacy_data_dir(), None

    return (
        None,
        "multiple TAP Hermes identities configured — pass `identity` to select one",
    )


def _ensure_tapd_running(socket_path: Path, data_dir: Path) -> tuple[bool, str | None]:
    """Auto-start tapd for the chosen identity if the socket is missing.

    The child is spawned with ``TAP_DATA_DIR=<data_dir>`` so the right
    per-identity daemon comes up instead of the default one. Preserves
    the auto-start behavior from before F4.1 but targets the resolved
    identity rather than a global default.
    """
    if socket_path.exists():
        return True, None
    tap_bin = shutil.which("tap")
    if not tap_bin:
        return False, "`tap` binary not found on PATH; cannot start tapd"
    child_env = os.environ.copy()
    child_env["TAP_DATA_DIR"] = str(data_dir)
    try:
        subprocess.Popen(
            [tap_bin, "daemon", "start"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            env=child_env,
        )
    except OSError as exc:
        return False, f"failed to spawn `tap daemon start`: {exc}"
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return True, None
        time.sleep(DAEMON_START_POLL_SECONDS)
    return False, "tapd did not start within timeout"


def _http_request(
    method: str,
    path: str,
    socket_path: Path,
    body: dict | None = None,
    auto_start: bool = True,
) -> Any:
    """Send an HTTP request to tapd over a Unix socket.

    ``auto_start`` controls whether a missing socket triggers ``tap daemon
    start`` with a 5-second wait. Interactive paths (send/transfer/connect)
    use ``auto_start=True`` so a first-time request boots tapd. The
    ``pre_llm_call`` notification drain path MUST pass ``auto_start=False``
    because it runs on every prompt — a dead identity would otherwise add
    ``DAEMON_START_TIMEOUT_SECONDS`` of latency to every turn, multiplied by
    the number of dead identities. Drain is strictly a fast-fail read path:
    a missing socket is reported back immediately as an error string and
    surfaced as a meta escalation by ``drain_all_identities``.
    """
    if not socket_path.exists():
        if not auto_start:
            return {"error": f"tapd socket missing at {socket_path}. {DEFAULT_RECOVERY_GUIDANCE}"}
        running, note = _ensure_tapd_running(socket_path, socket_path.parent)
        if not running:
            return {"error": f"tapd is not running: {note}. {DEFAULT_RECOVERY_GUIDANCE}"}

    conn = _UnixHTTPConnection(str(socket_path))
    try:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        body_json = json.dumps(body) if body is not None else None
        conn.request(method, path, body=body_json, headers=headers)
        response = conn.getresponse()
        raw = response.read().decode("utf-8")
        payload: Any
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return {"error": f"tapd returned invalid JSON: {raw[:200]}"}
        if response.status >= 400:
            error = (payload or {}).get("error") if isinstance(payload, dict) else None
            message = error.get("message") if isinstance(error, dict) else None
            return {"error": message or f"tapd returned HTTP {response.status}"}
        return payload
    except OSError as exc:
        return {"error": f"failed to reach tapd at {socket_path}: {exc}. {DEFAULT_RECOVERY_GUIDANCE}"}
    finally:
        conn.close()


def _dispatch(action: str, params: dict, socket_path: Path) -> Any:
    """Route the action to the matching tapd HTTP endpoint.

    Split out so ``send_request`` can resolve the identity first and
    then hand off to the dispatcher with a fully-resolved socket path.
    """
    if action == "status":
        return _http_request("GET", "/daemon/health", socket_path)

    if action == "sync":
        return _http_request("POST", "/daemon/sync", socket_path)

    if action == "restart":
        # Restart = shutdown, then auto-start on next request.
        result = _http_request("POST", "/daemon/shutdown", socket_path)
        return {"ok": True, "previous": result}

    if action == "create_invite":
        body: dict[str, Any] = {}
        if params.get("expires_in_seconds") is not None:
            body["expiresInSeconds"] = params["expires_in_seconds"]
        return _http_request("POST", "/api/invites", socket_path, body=body)

    if action == "connect":
        body = {}
        if params.get("invite_url") is not None:
            body["inviteUrl"] = params["invite_url"]
        if params.get("wait_ms") is not None:
            body["waitMs"] = params["wait_ms"]
        return _http_request("POST", "/api/connect", socket_path, body=body)

    if action == "send_message":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("text") is not None:
            body["text"] = params["text"]
        if params.get("scope") is not None:
            body["scope"] = params["scope"]
        if params.get("auto_generated") is not None:
            body["autoGenerated"] = params["auto_generated"]
        return _http_request("POST", "/api/messages", socket_path, body=body)

    if action == "publish_grants":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("grant_set") is not None:
            body["grantSet"] = params["grant_set"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        return _http_request("POST", "/api/grants/publish", socket_path, body=body)

    if action == "request_grants":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("grant_set") is not None:
            body["grantSet"] = params["grant_set"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        return _http_request("POST", "/api/grants/request", socket_path, body=body)

    if action == "request_funds":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("asset") is not None:
            body["asset"] = params["asset"]
        if params.get("amount") is not None:
            body["amount"] = params["amount"]
        if params.get("chain") is not None:
            body["chain"] = params["chain"]
        if params.get("to_address") is not None:
            body["toAddress"] = params["to_address"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        return _http_request("POST", "/api/funds-requests", socket_path, body=body)

    if action == "transfer":
        body = {}
        if params.get("asset") is not None:
            body["asset"] = params["asset"]
        if params.get("amount") is not None:
            body["amount"] = params["amount"]
        if params.get("chain") is not None:
            body["chain"] = params["chain"]
        if params.get("to_address") is not None:
            body["toAddress"] = params["to_address"]
        return _http_request("POST", "/api/transfers", socket_path, body=body)

    if action == "request_meeting":
        # tapd's /api/meetings accepts a flat shape and builds the full
        # SchedulingProposal centrally (generating schedulingId, defaulting
        # originTimezone, and turning `preferred` into a slot). The Python
        # client only has to forward the user-facing fields.
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("title") is not None:
            body["title"] = params["title"]
        if params.get("duration") is not None:
            body["duration"] = params["duration"]
        if params.get("preferred") is not None:
            body["preferred"] = params["preferred"]
        if params.get("location") is not None:
            body["location"] = params["location"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        if params.get("scheduling_id") is not None:
            body["schedulingId"] = params["scheduling_id"]
        return _http_request("POST", "/api/meetings", socket_path, body=body)

    if action == "respond_meeting":
        scheduling_id = params.get("scheduling_id")
        if not scheduling_id:
            return {"error": "scheduling_id is required"}
        body = {}
        meeting_action = params.get("meeting_action")
        if meeting_action is not None:
            body["approve"] = meeting_action == "accept"
        if params.get("reason") is not None:
            body["reason"] = params["reason"]
        path = f"/api/meetings/{quote(str(scheduling_id), safe='')}/respond"
        return _http_request("POST", path, socket_path, body=body)

    if action == "cancel_meeting":
        scheduling_id = params.get("scheduling_id")
        if not scheduling_id:
            return {"error": "scheduling_id is required"}
        body = {}
        if params.get("reason") is not None:
            body["reason"] = params["reason"]
        path = f"/api/meetings/{quote(str(scheduling_id), safe='')}/cancel"
        return _http_request("POST", path, socket_path, body=body)

    if action == "list_pending":
        return _http_request("GET", "/api/pending", socket_path)

    if action == "resolve_pending":
        request_id = params.get("request_id")
        if not request_id:
            return {"error": "request_id is required"}
        approve = bool(params.get("approve"))
        verb = "approve" if approve else "deny"
        path = f"/api/pending/{quote(str(request_id), safe='')}/{verb}"
        body = {}
        if params.get("note") is not None:
            body["note"] = params["note"]
        if params.get("reason") is not None:
            body["reason"] = params["reason"]
        return _http_request("POST", path, socket_path, body=body)

    if action == "drain_notifications":
        return _http_request("GET", "/api/notifications/drain", socket_path)

    return {"error": f"unknown action: {action}"}


def send_request(action: str, params: dict | None = None) -> Any:
    """Dispatch a Hermes tap_gateway action to the tapd HTTP API.

    Resolves the target identity from the Hermes plugin config on each
    call, then derives the per-identity socket path. The ``identity``
    field in ``params`` is consumed here and NOT forwarded to tapd.
    """
    params = params or {}
    if not isinstance(action, str) or not action.strip():
        return {"error": "action is required"}

    identity_arg = params.get("identity")
    data_dir, err = _resolve_target_data_dir(identity_arg)
    if err is not None or data_dir is None:
        return {"error": err or "failed to resolve tapd data dir"}

    # Strip the identity key so it doesn't leak into tapd request bodies.
    dispatch_params = {k: v for k, v in params.items() if k != "identity"}
    socket_path = data_dir / SOCKET_NAME
    return _dispatch(action, dispatch_params, socket_path)


def _drain_one(socket_path: Path) -> tuple[list[dict], str | None]:
    """Drain notifications from a single tapd socket.

    Returns ``(notifications, error)``. On success, ``error`` is None. On
    failure (socket missing, HTTP error, malformed response), returns an
    empty list plus an error string for the caller to surface as a
    meta-notification.

    Drain runs on every prompt via the ``pre_llm_call`` hook, so it MUST
    be fast-fail: passing ``auto_start=False`` means a dead identity returns
    immediately instead of blocking the prompt for ``DAEMON_START_TIMEOUT_SECONDS``
    waiting for a daemon that may never come up.
    """
    result = _http_request("GET", "/api/notifications/drain", socket_path, auto_start=False)
    if isinstance(result, dict) and "error" in result and "notifications" not in result:
        return [], str(result.get("error") or "unknown error")
    if not isinstance(result, dict):
        return [], "tapd returned a non-object drain response"
    notifications = result.get("notifications")
    if not isinstance(notifications, list):
        return [], "tapd drain response missing `notifications` array"
    normalized: list[dict] = [n for n in notifications if isinstance(n, dict)]
    return normalized, None


def _meta_error_notification(identity_name: str, reason: str) -> dict[str, Any]:
    """Build a meta escalation surfaced when an identity drain fails.

    Operators need to see that a specific tapd is unreachable — silently
    dropping the error would hide approval backlogs accumulating in a
    quiet daemon.
    """
    return {
        "type": "escalation",
        "oneLiner": f"Hermes: unable to reach tapd for identity {identity_name}: {reason}",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "identity": identity_name,
    }


def drain_all_identities() -> list[dict]:
    """Drain notifications from every configured Hermes identity.

    Each identity has its own tapd and its own per-identity notification
    queue, so the Hermes ``pre_llm_call`` hook must drain each one and
    merge the results. Notifications are tagged with the source identity
    so the injection layer can label them when more than one identity
    contributed.

    Fallback rules:
      - Zero entries (legacy single-agent setup or missing config): drain
        once from the default socket (``TAP_DATA_DIR`` / ``~/.trustedagents``).
        The returned notifications carry no identity tag.
      - One entry: drain that identity once and tag its notifications.
      - Two or more entries: drain each identity in config order and tag
        every notification with its ``name``. Per-identity failures are
        surfaced as an escalation meta-notification rather than silently
        swallowed.

    This function never raises; a configuration error is returned as a
    single meta-notification so the operator sees the issue instead of
    an empty injection block.
    """
    try:
        identities = _load_hermes_identities()
    except RuntimeError as exc:
        return [
            {
                "type": "escalation",
                "oneLiner": f"Hermes: TAP plugin config error: {exc}",
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        ]

    if len(identities) == 0:
        data_dir = _legacy_data_dir()
        socket_path = data_dir / SOCKET_NAME
        drained, err = _drain_one(socket_path)
        if err is not None:
            return [_meta_error_notification("default", err)]
        return drained

    merged: list[dict] = []
    for entry in identities:
        name = entry["name"]
        socket_path = Path(entry["dataDir"]) / SOCKET_NAME
        drained, err = _drain_one(socket_path)
        if err is not None:
            merged.append(_meta_error_notification(name, err))
            continue
        for notification in drained:
            tagged = dict(notification)
            tagged.setdefault("identity", name)
            merged.append(tagged)
    return merged


def format_notification_context(notifications: list[dict]) -> dict[str, str] | None:
    """Format drained notifications into a Hermes pre_llm_call context payload.

    When notifications come from more than one identity (multi-identity
    Hermes setups), each line is prefixed with ``[identity]`` so the
    operator knows which agent raised it. Legacy single-identity output
    is unchanged: no identity tag on the notifications means no prefix
    in the rendered block.
    """
    if not notifications:
        return None

    labels = {
        "escalation": "ESCALATION",
        "summary": "SUMMARY",
        "auto-reply": "AUTO-REPLY",
        "info": "INFO",
    }

    distinct_identities: set[str] = set()
    for notification in notifications:
        identity = notification.get("identity")
        if isinstance(identity, str) and identity.strip():
            distinct_identities.add(identity.strip())
    show_identity_prefix = len(distinct_identities) >= 2

    lines = ["[TAP Notifications]"]
    rendered = 0
    for notification in notifications[:20]:
        label = labels.get(notification.get("type"), "INFO")
        one_liner = str(notification.get("oneLiner") or "").strip()
        if not one_liner:
            continue
        identity = notification.get("identity")
        if (
            show_identity_prefix
            and isinstance(identity, str)
            and identity.strip()
        ):
            lines.append(f"- {label} [{identity.strip()}]: {one_liner}")
        else:
            lines.append(f"- {label}: {one_liner}")
        rendered += 1

    if rendered == 0:
        return None

    remaining = len(notifications) - 20
    if remaining > 0:
        lines.append(f"- SUMMARY: {remaining} more TAP notifications omitted.")

    lines.append("Use tap_gateway for transport-active TAP actions inside Hermes.")
    return {"context": "\n".join(lines)}
