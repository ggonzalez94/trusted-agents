"""Local IPC client for the TAP Hermes daemon."""

from __future__ import annotations

import os
import json
import socket
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parent
STATE_DIR = PLUGIN_DIR / "state"
DAEMON_STATE_PATH = STATE_DIR / "daemon.json"
DAEMON_LOG_PATH = STATE_DIR / "daemon.log"
RESPAWN_STATE_PATH = STATE_DIR / "respawn.json"
RESPAWN_LOCK_PATH = STATE_DIR / "respawn.lock"
DEFAULT_SOCKET_PATH = STATE_DIR / "tap-hermes.sock"
DEFAULT_TIMEOUT_SECONDS = 10.0
STARTUP_GRACE_SECONDS = 1.0
RESPAWN_WAIT_SECONDS = 3.0
RESPAWN_POLL_SECONDS = 0.05
RESPAWN_COOLDOWN_SECONDS = 10.0
DEFAULT_RECOVERY_GUIDANCE = (
    "Start or restart `hermes gateway` after running `tap hermes configure`."
)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _read_daemon_state() -> dict[str, Any]:
    state = _read_json(DAEMON_STATE_PATH, {})
    return state if isinstance(state, dict) else {}


def _resolve_socket_path() -> str:
    state = _read_daemon_state()
    socket_path = state.get("socketPath")
    if isinstance(socket_path, str) and socket_path.strip():
        return socket_path
    return str(DEFAULT_SOCKET_PATH)


def send_request(method: str, params: dict | None = None) -> Any:
    if not method or not isinstance(method, str):
        return {"error": "Hermes TAP request is missing a valid method"}

    payload = {"method": method, "params": params or {}}
    recovery_attempted = False

    for _ in range(2):
        socket_path = _resolve_socket_path()
        try:
            return _send_request_once(socket_path, payload)
        except OSError as exc:
            if not recovery_attempted and _is_recoverable_socket_error(exc):
                restarted, note = _ensure_daemon_running()
                if restarted:
                    recovery_attempted = True
                    continue
                return {"error": _format_socket_error(socket_path, exc, note)}
            note = (
                "Automatic Hermes TAP daemon recovery was attempted but the daemon is still unavailable."
                if recovery_attempted
                else None
            )
            return {"error": _format_socket_error(socket_path, exc, note)}
        except RuntimeError as exc:
            return {"error": str(exc)}

    return {
        "error": (
            "Hermes TAP daemon recovery exhausted without a response. "
            f"{DEFAULT_RECOVERY_GUIDANCE}"
        )
    }


def _send_request_once(socket_path: str, payload: dict[str, Any]) -> Any:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(DEFAULT_TIMEOUT_SECONDS)
        client.connect(socket_path)
        client.sendall((json.dumps(payload) + "\n").encode("utf-8"))

        chunks: list[bytes] = []
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break

    raw = b"".join(chunks).decode("utf-8").strip()
    if not raw:
        raise RuntimeError("Hermes TAP daemon closed the connection without a response")

    try:
        response = json.loads(raw.splitlines()[0])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Hermes TAP daemon returned invalid JSON: {exc}") from exc

    if not response.get("ok"):
        error = response.get("error") or {}
        message = error.get("message") if isinstance(error, dict) else None
        raise RuntimeError(message or "Hermes TAP daemon request failed")

    return response.get("result")


def _is_recoverable_socket_error(exc: OSError) -> bool:
    return isinstance(exc, (FileNotFoundError, ConnectionRefusedError)) or exc.errno in {
        2,
        61,
        111,
    }


def _ensure_daemon_running() -> tuple[bool, str | None]:
    state = _read_daemon_state()
    current_gateway_pid = os.getpid()
    daemon_pid = state.get("pid")
    daemon_gateway_pid = state.get("gatewayPid")

    if (
        isinstance(daemon_pid, int)
        and daemon_pid > 0
        and _is_process_alive(daemon_pid)
        and daemon_gateway_pid == current_gateway_pid
    ):
        if _wait_for_socket(RESPAWN_WAIT_SECONDS):
            return True, None
        return (
            False,
            "A TAP daemon is already registered for this Hermes gateway but is not reachable. "
            f"{DEFAULT_RECOVERY_GUIDANCE}",
        )

    if not _should_attempt_respawn(current_gateway_pid):
        return (
            False,
            "A recent Hermes TAP daemon recovery attempt already ran. "
            f"{DEFAULT_RECOVERY_GUIDANCE}",
        )

    lock_fd = _acquire_respawn_lock()
    if lock_fd is None:
        if _wait_for_socket(RESPAWN_WAIT_SECONDS):
            return True, None
        return (
            False,
            "Hermes TAP daemon recovery is already in progress, but the daemon is still unavailable. "
            f"{DEFAULT_RECOVERY_GUIDANCE}",
        )

    try:
        if _wait_for_socket(STARTUP_GRACE_SECONDS):
            return True, None

        _record_respawn_attempt(current_gateway_pid)
        tap_bin = shutil.which("tap")
        if not tap_bin:
            return False, "`tap` was not found on PATH, so Hermes TAP daemon recovery cannot start."

        _spawn_daemon(tap_bin, current_gateway_pid)
        if _wait_for_socket(RESPAWN_WAIT_SECONDS):
            return True, None
        return False, f"Automatic Hermes TAP daemon recovery timed out. {DEFAULT_RECOVERY_GUIDANCE}"
    finally:
        _release_respawn_lock(lock_fd)


def _should_attempt_respawn(gateway_pid: int) -> bool:
    state = _read_json(RESPAWN_STATE_PATH, {})
    if not isinstance(state, dict):
        return True
    if state.get("gatewayPid") != gateway_pid:
        return True
    last_attempt_at = state.get("lastAttemptAt")
    if not isinstance(last_attempt_at, (int, float)):
        return True
    return (time.time() - float(last_attempt_at)) >= RESPAWN_COOLDOWN_SECONDS


def _record_respawn_attempt(gateway_pid: int) -> None:
    _write_json(
        RESPAWN_STATE_PATH,
        {
            "gatewayPid": gateway_pid,
            "lastAttemptAt": time.time(),
        },
    )


def _acquire_respawn_lock() -> int | None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    if RESPAWN_LOCK_PATH.exists():
        try:
            if (time.time() - RESPAWN_LOCK_PATH.stat().st_mtime) > (
                RESPAWN_WAIT_SECONDS + RESPAWN_COOLDOWN_SECONDS
            ):
                RESPAWN_LOCK_PATH.unlink()
        except FileNotFoundError:
            pass

    try:
        fd = os.open(RESPAWN_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return None

    os.write(fd, f"{os.getpid()}\n".encode("utf-8"))
    return fd


def _release_respawn_lock(fd: int) -> None:
    try:
        os.close(fd)
    finally:
        try:
            RESPAWN_LOCK_PATH.unlink()
        except FileNotFoundError:
            pass


def _spawn_daemon(tap_bin: str, gateway_pid: int) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with DAEMON_LOG_PATH.open("a", encoding="utf-8") as log_file:
        subprocess.Popen(
            [
                tap_bin,
                "hermes",
                "daemon",
                "run",
                "--gateway-pid",
                str(gateway_pid),
                "--hermes-home",
                str(Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))),
                "--plain",
            ],
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            close_fds=True,
        )


def _wait_for_socket(timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        socket_path = Path(_resolve_socket_path())
        daemon_state = _read_daemon_state()
        daemon_pid = daemon_state.get("pid")
        if socket_path.exists() and (
            not isinstance(daemon_pid, int) or daemon_pid < 1 or _is_process_alive(daemon_pid)
        ):
            return True
        time.sleep(RESPAWN_POLL_SECONDS)
    return False


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _format_socket_error(socket_path: str, exc: OSError, note: str | None = None) -> str:
    if isinstance(exc, FileNotFoundError) or exc.errno == 2:
        base = f"Hermes TAP daemon socket not found at {socket_path}."
    else:
        base = f"Failed to reach the Hermes TAP daemon at {socket_path}: {exc}."
    return f"{base} {note or DEFAULT_RECOVERY_GUIDANCE}"


def format_notification_context(notifications: list[dict]) -> dict[str, str] | None:
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
