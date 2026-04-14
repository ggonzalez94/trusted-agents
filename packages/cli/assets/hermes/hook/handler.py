"""Startup hook that ensures tapd is running for Hermes plugin use."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

DEFAULT_DATA_DIR = Path(os.environ.get("TAP_DATA_DIR", Path.home() / ".trustedagents"))
SOCKET_NAME = ".tapd.sock"
START_TIMEOUT_SECONDS = 5.0
POLL_SECONDS = 0.1


async def handle(event_type: str, context: dict) -> None:
    """Start tapd in the background if it isn't already running.

    Called by the Hermes startup hook. Best-effort: if ``tap`` is missing
    or the daemon doesn't come up, the plugin's client will surface the
    error to the user on the first tap_gateway call.
    """
    socket_path = DEFAULT_DATA_DIR / SOCKET_NAME
    if socket_path.exists():
        return

    tap_bin = shutil.which("tap")
    if not tap_bin:
        print(
            "[trusted-agents-tap] `tap` not found on PATH; skipping tapd startup",
            flush=True,
        )
        return

    try:
        subprocess.Popen(
            [tap_bin, "daemon", "start"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as exc:
        print(
            f"[trusted-agents-tap] failed to spawn `tap daemon start`: {exc}",
            flush=True,
        )
        return

    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return
        time.sleep(POLL_SECONDS)
