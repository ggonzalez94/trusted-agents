"""HTTP client over Unix socket for the local tapd daemon."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from http.client import HTTPConnection
from pathlib import Path
from typing import Any
from urllib.parse import quote

DEFAULT_DATA_DIR = Path(os.environ.get("TAP_DATA_DIR", Path.home() / ".trustedagents"))
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


def _resolve_socket_path() -> Path:
    return DEFAULT_DATA_DIR / SOCKET_NAME


def _ensure_tapd_running() -> tuple[bool, str | None]:
    socket_path = _resolve_socket_path()
    if socket_path.exists():
        return True, None
    tap_bin = shutil.which("tap")
    if not tap_bin:
        return False, "`tap` binary not found on PATH; cannot start tapd"
    try:
        subprocess.Popen(
            [tap_bin, "daemon", "start"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as exc:
        return False, f"failed to spawn `tap daemon start`: {exc}"
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return True, None
        time.sleep(DAEMON_START_POLL_SECONDS)
    return False, "tapd did not start within timeout"


def _http_request(method: str, path: str, body: dict | None = None) -> Any:
    socket_path = _resolve_socket_path()
    if not socket_path.exists():
        running, note = _ensure_tapd_running()
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


def _filtered(params: dict, keys: tuple[str, ...]) -> dict:
    """Return a copy of params filtered to keys, dropping None values."""
    return {k: params[k] for k in keys if params.get(k) is not None}


def send_request(action: str, params: dict | None = None) -> Any:
    """Dispatch a Hermes tap_gateway action to the tapd HTTP API."""
    params = params or {}
    if not isinstance(action, str) or not action.strip():
        return {"error": "action is required"}

    if action == "status":
        return _http_request("GET", "/daemon/health")

    if action == "sync":
        return _http_request("POST", "/daemon/sync")

    if action == "restart":
        # Restart = shutdown, then auto-start on next request.
        result = _http_request("POST", "/daemon/shutdown")
        return {"ok": True, "previous": result}

    if action == "create_invite":
        body = {}
        if params.get("expires_in_seconds") is not None:
            body["expiresInSeconds"] = params["expires_in_seconds"]
        return _http_request("POST", "/api/invites", body=body)

    if action == "connect":
        body = {}
        if params.get("invite_url") is not None:
            body["inviteUrl"] = params["invite_url"]
        if params.get("wait_ms") is not None:
            body["waitMs"] = params["wait_ms"]
        return _http_request("POST", "/api/connect", body=body)

    if action == "send_message":
        body: dict[str, Any] = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("text") is not None:
            body["text"] = params["text"]
        if params.get("scope") is not None:
            body["scope"] = params["scope"]
        if params.get("auto_generated") is not None:
            body["autoGenerated"] = params["auto_generated"]
        return _http_request("POST", "/api/messages", body=body)

    if action == "publish_grants":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("grant_set") is not None:
            body["grantSet"] = params["grant_set"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        return _http_request("POST", "/api/grants/publish", body=body)

    if action == "request_grants":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        if params.get("grant_set") is not None:
            body["grantSet"] = params["grant_set"]
        if params.get("note") is not None:
            body["note"] = params["note"]
        return _http_request("POST", "/api/grants/request", body=body)

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
        return _http_request("POST", "/api/funds-requests", body=body)

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
        return _http_request("POST", "/api/transfers", body=body)

    if action == "request_meeting":
        body = {}
        if params.get("peer") is not None:
            body["peer"] = params["peer"]
        proposal: dict[str, Any] = {}
        if params.get("title") is not None:
            proposal["title"] = params["title"]
        if params.get("duration") is not None:
            proposal["duration"] = params["duration"]
        if params.get("preferred") is not None:
            proposal["preferred"] = params["preferred"]
        if params.get("location") is not None:
            proposal["location"] = params["location"]
        if proposal:
            body["proposal"] = proposal
        return _http_request("POST", "/api/meetings", body=body)

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
        return _http_request("POST", path, body=body)

    if action == "cancel_meeting":
        scheduling_id = params.get("scheduling_id")
        if not scheduling_id:
            return {"error": "scheduling_id is required"}
        body = {}
        if params.get("reason") is not None:
            body["reason"] = params["reason"]
        path = f"/api/meetings/{quote(str(scheduling_id), safe='')}/cancel"
        return _http_request("POST", path, body=body)

    if action == "list_pending":
        return _http_request("GET", "/api/pending")

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
        return _http_request("POST", path, body=body)

    if action == "drain_notifications":
        return _http_request("GET", "/api/notifications/drain")

    return {"error": f"unknown action: {action}"}


def format_notification_context(notifications: list[dict]) -> dict[str, str] | None:
    """Format drained notifications into a Hermes pre_llm_call context payload."""
    if not notifications:
        return None

    labels = {
        "escalation": "ESCALATION",
        "summary": "SUMMARY",
        "auto-reply": "AUTO-REPLY",
        "info": "INFO",
    }

    lines = ["[TAP Notifications]"]
    rendered = 0
    for notification in notifications[:20]:
        label = labels.get(notification.get("type"), "INFO")
        one_liner = str(notification.get("oneLiner") or "").strip()
        if not one_liner:
            continue
        lines.append(f"- {label}: {one_liner}")
        rendered += 1

    if rendered == 0:
        return None

    remaining = len(notifications) - 20
    if remaining > 0:
        lines.append(f"- SUMMARY: {remaining} more TAP notifications omitted.")

    lines.append("Use tap_gateway for transport-active TAP actions inside Hermes.")
    return {"context": "\n".join(lines)}
