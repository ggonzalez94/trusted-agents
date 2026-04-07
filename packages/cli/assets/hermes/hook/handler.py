"""Startup hook that launches the TAP Hermes daemon."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
PLUGIN_DIR = HERMES_HOME / "plugins" / "trusted-agents-tap"
STATE_DIR = PLUGIN_DIR / "state"
DAEMON_STATE_PATH = STATE_DIR / "daemon.json"
DAEMON_LOG_PATH = STATE_DIR / "daemon.log"


def _read_daemon_state() -> dict:
    try:
        return json.loads(DAEMON_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def handle(event_type: str, context: dict) -> None:
    gateway_pid = os.getpid()
    state = _read_daemon_state()
    running_pid = state.get("pid")
    running_gateway_pid = state.get("gatewayPid")
    if (
        isinstance(running_pid, int)
        and running_pid > 0
        and _is_process_alive(running_pid)
        and running_gateway_pid == gateway_pid
    ):
        return

    tap_bin = shutil.which("tap")
    if not tap_bin:
        print("[trusted-agents-tap] `tap` not found on PATH; skipping Hermes TAP daemon startup", flush=True)
        return

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
                str(HERMES_HOME),
                "--plain",
            ],
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            close_fds=True,
        )
