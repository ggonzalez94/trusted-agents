Choose TAP runtime mode inside OpenClaw:

1. `tap_gateway` tool available and `tap_gateway` action `status` shows at least one configured identity and no warnings:
Use plugin mode. Gateway owns streaming and periodic reconcile.

2. OpenClaw without plugin:
Use `tap message sync` on heartbeat. This is the safe default. Do not rely on shell background jobs to keep `tap message listen` alive.

Operational rules:

- Plugin mode: use `tap_gateway` for connect, send, grant publication, fund requests, and pending approvals. Read-only `tap` CLI commands remain safe.
- Plugin mode: transport-active `tap` CLI commands can queue behind the plugin owner for the same `dataDir`, but `tap_gateway` is still the preferred and most direct interface.
- Plugin mode with multiple identities: get the target `dataDir` from `tap_gateway` status for that `identity`, then pass `--data-dir <path>` to read-only `tap` CLI commands.
- Even when streaming is enabled, keep periodic sync for reconciliation.
