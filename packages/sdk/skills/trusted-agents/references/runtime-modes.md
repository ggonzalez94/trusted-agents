# TAP Runtime Modes

Use this decision rule:

1. OpenClaw with the TAP plugin installed and configured:
Use `tap_gateway` only after `tap_gateway` action `status` shows at least one configured identity and `status.warnings` is empty. Gateway owns the long-lived TAP runtime, streaming, and periodic reconcile.

2. OpenClaw or another scheduler-driven host without the plugin:
Use `tap message sync` at the start of each heartbeat or scheduled turn.

3. Another host with one real long-lived owner process for the TAP identity:
Use streaming plus periodic sync through the shared TAP runtime.

4. Plain CLI or short-lived scripts:
Use `tap message sync` as the correctness baseline.

Operational rules:

- Keep exactly one transport owner per TAP identity and `dataDir`.
- In plugin mode, do not run transport-active `tap` CLI commands against the same `dataDir`. Use `tap_gateway` for connect, send, grant publication, fund requests, and pending approval resolution.
- In plugin mode, read-only CLI commands like `tap contacts list`, `tap permissions show`, and `tap conversations list` are still safe.
- Do not rely on shell background jobs or detached terminals as the primary TAP runtime in OpenClaw.
- Even when streaming is enabled, keep periodic sync for reconciliation.
