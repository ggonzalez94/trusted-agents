# tapd Phase 4: Hermes Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or run inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the standalone Hermes TAP daemon (`packages/cli/src/hermes/daemon.ts` and friends) and rewire the Hermes Python plugin to talk to `tapd` directly. After Phase 4, Hermes users get a thinner, simpler plugin that uses tapd for all transport — no parallel daemon process, no parallel notification queue.

**Architecture:** The Hermes Python plugin becomes a thin client of tapd's HTTP API over the Unix socket at `<dataDir>/.tapd.sock`. The Python plugin's pre-llm-call hook drains notifications from `GET /api/notifications/drain`. The `tap_gateway` Hermes tool maps each action to a tapd HTTP endpoint. The startup hook ensures tapd is running. The TypeScript Hermes daemon code is deleted. CLI hermes wrapper commands (`tap hermes status|sync|restart`) become thin forwarders to `tap daemon` equivalents.

**Tech stack:** Python's standard library (`http.client`, `socket`) for HTTP-over-Unix-socket. No new Python dependencies. The TypeScript side adds nothing — only deletes and modifies.

**Out of scope for Phase 4:**
- The OpenClaw plugin migration (Phase 5)
- New Hermes features
- Multi-identity selection improvements (the `identity` parameter on `tap_gateway` is already supported by tapd config)

**Note for executors — read this carefully.**

This phase deletes a lot of working TypeScript code. Be **careful**:
1. Before deleting any file, search the repo with Grep for any remaining imports of its exports. If found, those callers also need updating in the same task.
2. The Hermes daemon was the prototype `tapd` was modeled after — they share patterns. tapd already has the equivalent functionality. The deletion is not a regression; it's consolidation.
3. The Python plugin currently maps action names like `send_message`, `connect`, `transfer` to the daemon's IPC method names. After Phase 4, those action names map to tapd HTTP endpoints. The mapping table is in Task 2.

**Bearer token note:** tapd's auth middleware skips the bearer check for Unix socket connections. The Python plugin connects to `<dataDir>/.tapd.sock` (Unix socket), so no bearer token is needed. Skip the token plumbing on the Python side entirely.

---

## File map

**Modified in `packages/cli/assets/hermes/plugin/`:**

```
client.py                      # Rewrite: HTTP-over-Unix-socket client for tapd
__init__.py                    # Update action mapping, drain endpoint, schema unchanged
plugin.yaml                    # Confirm: should declare the same hooks
```

**Modified in `packages/cli/assets/hermes/hook/`:**

```
handler.py                     # Replace daemon spawn with `tap daemon start` invocation
HOOK.yaml                      # Confirm event registration
```

**Deleted from `packages/cli/src/hermes/`:**

```
daemon.ts                      # Old Hermes daemon class
client.ts                      # Old Hermes IPC client
ipc.ts                         # Old Hermes IPC server
registry.ts                    # Per-identity TapMessagingService registry
notifications.ts               # File-based notification store (queue lives in tapd now)
file-lock.ts                   # Daemon lock helper (tapd has its own)
event-classifier.ts            # Now a re-export from core (kept until Phase 4 deletes too)
```

**Kept in `packages/cli/src/hermes/`:**

```
install.ts                     # Install-time plumbing for `tap install --runtime hermes`
config.ts                      # Hermes plugin config types
```

**Modified in `packages/cli/`:**

```
src/cli.ts                     # Replace tap hermes status/sync/restart with thin wrappers; remove tap hermes daemon run
src/commands/hermes.ts         # Update to call tapd via tap daemon equivalents
test/hermes-event-classifier.test.ts  # Already deleted in Phase 1; verify
test/hermes/                   # Update tests to expect the new behavior
```

**Modified in `packages/cli/src/hermes/install.ts`:**

The install logic stays but its targets shift. The hook script copy stays. The daemon-related state files no longer get created. The plugin install copy stays.

---

## Pre-flight: read these files

Before starting, the implementer should read in order:

1. `packages/cli/assets/hermes/plugin/client.py` — current IPC client. The biggest rewrite target.
2. `packages/cli/assets/hermes/plugin/__init__.py` — current action mapping. Need to map all 15 actions to tapd HTTP routes.
3. `packages/cli/assets/hermes/hook/handler.py` — current daemon-spawn hook. Becomes a `tap daemon start` shim.
4. `packages/cli/src/hermes/install.ts` — install-time plumbing. Confirm what it does and what it touches.
5. `packages/cli/src/cli.ts` — find the `tap hermes` command registrations (around lines 78-148).
6. `packages/tapd/src/http/server.ts` — confirm the Unix socket auth fast-path (no bearer needed).
7. `packages/cli/src/lib/tapd-client.ts` — to mirror the methods/endpoint paths from Phase 3.
8. `packages/cli/src/lib/tapd-spawn.ts` — to understand how `tap daemon start` already works.

---

## Action → tapd endpoint mapping table

The Hermes plugin's `tap_gateway` tool exposes 15 actions. Each maps to a tapd HTTP endpoint:

| Hermes action | HTTP method | tapd endpoint | Notes |
|---|---|---|---|
| `status` | GET | `/daemon/health` | Or merge with `/api/identity` |
| `sync` | POST | `/daemon/sync` | Returns the sync report |
| `restart` | POST | `/daemon/shutdown` then re-start | Or document as no-op (just `tap daemon restart`) |
| `create_invite` | (local) | n/a | Invite creation is local crypto, no transport — call into core directly OR add a tapd write endpoint. **Decision: add `POST /api/invites` for symmetry.** |
| `connect` | POST | `/api/connect` | |
| `send_message` | POST | `/api/messages` | |
| `publish_grants` | POST | `/api/grants/publish` | |
| `request_grants` | POST | `/api/grants/request` | |
| `request_funds` | POST | `/api/funds-requests` | |
| `transfer` | POST | `/api/transfers` | |
| `request_meeting` | POST | `/api/meetings` | |
| `respond_meeting` | POST | `/api/meetings/:scheduling_id/respond` | |
| `cancel_meeting` | POST | `/api/meetings/:scheduling_id/cancel` | |
| `list_pending` | GET | `/api/pending` | |
| `resolve_pending` | POST | `/api/pending/:request_id/{approve,deny}` | Branch on `approve` boolean |
| (notification drain) | GET | `/api/notifications/drain` | Used by the pre-llm-call hook, not tap_gateway |

**`create_invite` decision:** add a new tapd route `POST /api/invites` in this phase. It wraps the existing `generateInvite` core function, takes optional `expires_in_seconds`, and returns the invite URL. This keeps the Python plugin uniform — every action is a tapd HTTP call.

---

## Task 1: Add tapd POST /api/invites

**Why first:** unblocks the `create_invite` action mapping for the Python plugin without coupling Phase 4 to other phases.

**Files:**
- Create: `packages/tapd/src/http/routes/invites.ts`
- Create: `packages/tapd/test/unit/routes/invites.test.ts`
- Modify: `packages/tapd/src/daemon.ts` (register route)

- [ ] **Step 1: Read `generateInvite` and `tap invite create` for the contract**

`packages/core/src/connection/...` for the function. `packages/cli/src/commands/invite-create.ts` for the existing CLI command's input/output shape.

- [ ] **Step 2: Write the failing route test**

Mirror the pattern from existing route tests. Cover happy path + missing required fields error.

- [ ] **Step 3: Implement the route**

```ts
import type { TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

interface CreateInviteBody {
  expiresInSeconds?: number;
}

export function createInvitesRoute(
  /* whatever the daemon needs to call generateInvite */
): RouteHandler<unknown, unknown> {
  return async (_params, body) => {
    // Call into the equivalent of `generateInvite` and return the URL.
  };
}
```

The exact construction depends on whether `generateInvite` needs the signing provider, agent ID, chain, etc. — it almost certainly does. Wire it up similarly to how `transfers.ts` wires the on-chain executor.

- [ ] **Step 4: Register in `daemon.ts`**

Add the route registration. Update `DaemonOptions` if you need a new injected dependency (e.g., a `createInvite` function).

- [ ] **Step 5: Run tests, lint, typecheck**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(tapd): add POST /api/invites route"
```

---

## Task 2: Add `createInvite` method to `tapd-client.ts`

**Files:**
- Modify: `packages/cli/src/lib/tapd-client.ts`
- Modify: `packages/cli/test/lib/tapd-client.test.ts`

Add a `createInvite(input)` method to the existing TS client. Test it. Commit: `feat(cli): add createInvite to tapd client`.

This is needed so the existing `tap invite create` CLI command (which is currently local) can be optionally rewired to go through tapd — though for Phase 4 that's not required. The Python plugin will call the same tapd endpoint directly, not through the TS client.

---

## Task 3: Rewrite `client.py` to use HTTP-over-Unix-socket

**Files:**
- Rewrite: `packages/cli/assets/hermes/plugin/client.py`

This is the biggest rewrite in Phase 4. The new `client.py` exposes `send_request(action, params)` (same signature as today) but underneath uses HTTP over Unix socket to talk to tapd.

**Implementation plan:**

```python
"""HTTP client over Unix socket for the local tapd daemon."""

from __future__ import annotations

import json
import os
import socket
import shutil
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
DEFAULT_RECOVERY_GUIDANCE = "Run `tap daemon start` to launch tapd."


class _UnixHTTPConnection(HTTPConnection):
    """HTTPConnection subclass that connects via a Unix domain socket."""

    def __init__(self, socket_path: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
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
    subprocess.Popen(
        [tap_bin, "daemon", "start"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return True, None
        time.sleep(0.1)
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


# Action → endpoint mapping table
def send_request(action: str, params: dict | None = None) -> Any:
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
        return _http_request("POST", "/api/invites", body={
            "expiresInSeconds": params.get("expires_in_seconds"),
        })
    if action == "connect":
        return _http_request("POST", "/api/connect", body={
            "inviteUrl": params.get("invite_url"),
            "waitMs": params.get("wait_ms"),
        })
    if action == "send_message":
        return _http_request("POST", "/api/messages", body={
            "peer": params.get("peer"),
            "text": params.get("text"),
            "scope": params.get("scope"),
            "autoGenerated": params.get("auto_generated"),
        })
    if action == "publish_grants":
        return _http_request("POST", "/api/grants/publish", body=params)
    if action == "request_grants":
        return _http_request("POST", "/api/grants/request", body=params)
    if action == "request_funds":
        return _http_request("POST", "/api/funds-requests", body=params)
    if action == "transfer":
        return _http_request("POST", "/api/transfers", body=params)
    if action == "request_meeting":
        return _http_request("POST", "/api/meetings", body=params)
    if action == "respond_meeting":
        scheduling_id = params.get("scheduling_id")
        if not scheduling_id:
            return {"error": "scheduling_id is required"}
        return _http_request("POST", f"/api/meetings/{quote(str(scheduling_id), safe='')}/respond", body=params)
    if action == "cancel_meeting":
        scheduling_id = params.get("scheduling_id")
        if not scheduling_id:
            return {"error": "scheduling_id is required"}
        return _http_request("POST", f"/api/meetings/{quote(str(scheduling_id), safe='')}/cancel", body=params)
    if action == "list_pending":
        return _http_request("GET", "/api/pending")
    if action == "resolve_pending":
        request_id = params.get("request_id")
        if not request_id:
            return {"error": "request_id is required"}
        approve = bool(params.get("approve"))
        path = f"/api/pending/{quote(str(request_id), safe='')}/{'approve' if approve else 'deny'}"
        body = {}
        if params.get("note"):
            body["note"] = params["note"]
        if params.get("reason"):
            body["reason"] = params["reason"]
        return _http_request("POST", path, body=body)
    if action == "drain_notifications":
        return _http_request("GET", "/api/notifications/drain")

    return {"error": f"unknown action: {action}"}


def format_notification_context(notifications: list[dict]) -> dict[str, str] | None:
    """Preserved verbatim from the previous implementation — see git blame."""
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
```

**Action items for the implementer:**
- Replace the entire `client.py` with the version above.
- Verify `format_notification_context` is preserved verbatim — it's the format the rest of Hermes expects.
- The `_ensure_tapd_running` helper is conservative: it only spawns `tap daemon start` once, with a short timeout. If tapd doesn't come up, return a clean error rather than retrying forever.

- [ ] **Step 1: Replace `client.py`**

Use Write tool to overwrite the entire file with the implementation above.

- [ ] **Step 2: Confirm there are no Python tests for the existing `client.py` to update**

Run: `find packages/cli/assets/hermes -name "test_*.py" -o -name "*_test.py"`

If any tests exist, update them. Otherwise note "no tests existed for this file" in the commit.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/assets/hermes/plugin/client.py
git commit -m "refactor(hermes-plugin): use HTTP over Unix socket against tapd"
```

---

## Task 4: Update `__init__.py` to drain notifications via tapd

**Files:**
- Modify: `packages/cli/assets/hermes/plugin/__init__.py`

The `inject_tap_notifications` function currently calls `send_request("drain_notifications")`. The new `client.py` already maps that action to `GET /api/notifications/drain`, so this function should work unchanged — verify by reading it after the rewrite.

The `handle_tap_gateway` function passes the action string and params dict to `send_request`. The new `client.py` handles the dispatch. Verify by re-reading.

The `TAP_GATEWAY_SCHEMA` action enum should be unchanged — no new actions, no removed actions.

If anything in `__init__.py` referenced internal helpers from the old `client.py` (e.g., daemon state files), strip those references.

- [ ] **Step 1: Read the file and confirm it does not need changes beyond a sanity check**
- [ ] **Step 2: If changes needed, make them and commit. Otherwise no commit.**

---

## Task 5: Replace the Hermes startup hook with a `tap daemon start` shim

**Files:**
- Rewrite: `packages/cli/assets/hermes/hook/handler.py`

The hook currently spawns the legacy Hermes daemon. After Phase 4, it just ensures tapd is running.

```python
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


async def handle(event_type: str, context: dict) -> None:
    socket_path = DEFAULT_DATA_DIR / SOCKET_NAME
    if socket_path.exists():
        return

    tap_bin = shutil.which("tap")
    if not tap_bin:
        return  # Best-effort; the plugin's client will surface the error to the user later.

    subprocess.Popen(
        [tap_bin, "daemon", "start"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )

    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return
        time.sleep(0.1)
```

- [ ] **Step 1: Replace `handler.py`**
- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(hermes-hook): start tapd instead of the legacy hermes daemon"
```

---

## Task 6: Refactor `tap hermes status|sync|restart` to forward to tapd

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/commands/hermes.ts` (or wherever the hermes commands live — find via grep)

The CLI hermes commands need to delegate to `tap daemon status|sync|restart` underneath. The semantics are identical now — there's only one daemon.

- `tap hermes status` → calls the same logic as `tap daemon status`, possibly with extra hermes-specific output (like "hermes home dir: ...")
- `tap hermes sync` → calls `tap daemon sync` underneath
- `tap hermes restart` → calls `tap daemon restart` underneath

`tap hermes daemon run` → DELETE entirely. It was the entrypoint for the old Hermes daemon. Nothing should call it after Phase 4.

`tap hermes configure` → keep as-is (it writes the config file).
`tap hermes remove` → keep as-is (uninstall).

- [ ] **Step 1: Find the hermes command file (`grep -rn 'hermes.command' packages/cli/src/`)**
- [ ] **Step 2: Refactor each subcommand**
- [ ] **Step 3: Delete `tap hermes daemon run`**
- [ ] **Step 4: Update tests in `packages/cli/test/hermes/`**
- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(cli): tap hermes status|sync|restart forward to tap daemon equivalents"
```

---

## Task 7: Delete the standalone Hermes daemon TypeScript code

**Files to delete:**
- `packages/cli/src/hermes/daemon.ts`
- `packages/cli/src/hermes/client.ts`
- `packages/cli/src/hermes/ipc.ts`
- `packages/cli/src/hermes/registry.ts`
- `packages/cli/src/hermes/notifications.ts`
- `packages/cli/src/hermes/file-lock.ts`
- `packages/cli/src/hermes/event-classifier.ts`

**Before deleting any file**, run `grep -rn "from.*hermes/<file>" packages/` to find any remaining imports. If found, those callers must be updated in the same task.

The CLI hermes command (refactored in Task 6) should no longer import from any of these. Verify.

The `packages/cli/test/hermes-event-classifier.test.ts` was already deleted in Phase 1 per the Phase 1 plan note.

The `packages/cli/test/hermes/*` tests that exercise the old daemon code should be deleted or rewritten to test the new HTTP-over-Unix-socket flow against an in-process tapd.

- [ ] **Step 1: Verify no imports remain (grep)**
- [ ] **Step 2: Delete each file**
- [ ] **Step 3: Update or delete tests in `packages/cli/test/hermes/`**
- [ ] **Step 4: Run `bun run typecheck && bun run lint && bun run test`**
- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(cli): delete standalone hermes daemon (now uses tapd)"
```

---

## Task 8: Update `tap install --runtime hermes`

**Files:**
- Modify: `packages/cli/src/hermes/install.ts`

The install logic:
1. Copies `packages/cli/assets/hermes/plugin/` and `packages/cli/assets/hermes/hook/` to `<HERMES_HOME>/plugins/trusted-agents-tap/` and `<HERMES_HOME>/hooks/`
2. Used to register the daemon-related state files and socket paths
3. Now: only the plugin and hook copies remain; no state directory needed (state lives in `<TAP_DATA_DIR>/.tapd.sock` etc.)

Read the current `install.ts`, identify the daemon-related state setup, and remove it. Keep the file copies and the configure-prompt flow.

- [ ] **Step 1: Read and edit**
- [ ] **Step 2: Run `tap install --runtime hermes --upgrade` smoke check (if possible)**
- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(cli): simplify hermes install — no daemon state to register"
```

---

## Task 9: Verify and commit Phase 4

- [ ] **Step 1: Run full repo test suite**
  - `bun run lint && bun run typecheck && bun run test`
- [ ] **Step 2: Run e2e mock tests**
  - `bun run --cwd packages/cli test test/e2e/e2e-mock.test.ts`
- [ ] **Step 3: Manually verify** the Hermes Python plugin can be imported and `send_request("drain_notifications")` returns the expected error when tapd isn't running:
  ```bash
  cd packages/cli/assets/hermes/plugin && python -c "from client import send_request; print(send_request('drain_notifications'))"
  ```
  Expected: a `{"error": "tapd is not running: ...}` object.
- [ ] **Step 4: Inventory `packages/cli/src/hermes/`**
  - Should now contain only `install.ts` and `config.ts`
- [ ] **Step 5: Final commit**

```bash
git commit -m "chore(hermes): final phase 4 cleanup"
```

**Phase 4 complete.** The Hermes plugin uses tapd directly. The standalone Hermes daemon is gone. The Hermes plugin is now ~400 lines smaller in TypeScript and the Python plugin is unchanged in API but reroutes everything through tapd. Phase 5 next: shrink the OpenClaw plugin in the same way.
