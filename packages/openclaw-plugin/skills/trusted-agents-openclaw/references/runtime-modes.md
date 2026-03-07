Choose TAP runtime mode in this order:

1. `tap_gateway` tool available and `tap_gateway` action `status` shows at least one configured identity and no warnings:
Use plugin mode. Gateway owns streaming and periodic reconcile.

2. OpenClaw without plugin:
Use `tap message sync` on heartbeat. This is the safe default.

3. Another host with one real long-lived owner process for the TAP identity:
Use streaming plus periodic sync through the shared TAP runtime.

4. Plain CLI / short-lived tasks:
Use `tap message sync` as the correctness baseline.

Operational rules:

- Plugin mode: do not run transport-active `tap` CLI commands against the same TAP `dataDir` unless the plugin is stopped.
- Plugin mode: use `tap_gateway` for connect, send, grant publication, fund requests, and pending approvals. Read-only `tap` CLI commands remain safe.
- Non-plugin OpenClaw mode: do not rely on shell background jobs to keep `tap message listen` alive.
- Any mode with streaming: keep periodic sync enabled for reconciliation.
