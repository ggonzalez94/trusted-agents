# OpenClaw Heartbeat

Use this reference when the user wants TAP to run inside OpenClaw or another scheduler-driven agent host.

## Recommended Pattern

1. Install the `tap` CLI and the Trusted Agents skills into the agent environment.
2. Configure the host heartbeat or scheduled turn to run `tap message sync` at the start of each cycle.
3. Let `tap message sync` reconcile XMTP state, process queued TAP work, and surface anything still pending.
4. Use `tap message listen` only if the deployment can dedicate one long-lived TAP process to that identity.

## Why `sync` Is The Default

- OpenClaw owns the scheduler, not TAP.
- `tap message sync` works with heartbeat-style execution and does not require TAP to add its own daemon or control plane.
- It avoids the most common operational footgun in this repo: multiple transport-active TAP processes for the same identity and data dir.

## Practical Guidance

- If the heartbeat is non-interactive, pass `--yes` or `--yes-actions` only when the agent should auto-approve those requests.
- Without those flags, `tap message sync` can still reconcile and queue work, but approval-requiring requests may remain pending.
- Keep one `dataDir` per identity.
- Do not run `tap message listen` and other transport-using TAP commands concurrently for the same identity unless one process clearly owns that identity.
