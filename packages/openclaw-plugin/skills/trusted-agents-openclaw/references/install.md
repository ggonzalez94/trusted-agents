Install the TAP OpenClaw plugin from this repository:

Recommended:

```bash
bash scripts/install.sh
```

Manual equivalent:

```bash
bun install
bun run build
cd packages/cli && npm link
tap install --runtime openclaw
```

Use `--link` for repo installs so OpenClaw loads the plugin directly from this checkout.

After install:

1. Onboard the TAP identity with `tap init` and `tap register`.
2. Configure one or more TAP identities in OpenClaw:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/tap-data","reconcileIntervalMinutes":10}]' --json
```

3. Restart the Gateway after plugin config changes.
4. Verify the runtime with `tap_gateway` action `status`.
5. Use plugin mode only when `status.configured` is `true`, the `identities` list is non-empty, and `status.warnings` is empty.
6. If more than one identity is configured, include `identity` in each `tap_gateway` tool call.
7. For read-only `tap` CLI inspection in multi-identity mode, use the matching `dataDir` from `status.identities[]` and pass `--data-dir <path>`.
8. Use `tap_gateway` for transport-active operations once the plugin is active.
