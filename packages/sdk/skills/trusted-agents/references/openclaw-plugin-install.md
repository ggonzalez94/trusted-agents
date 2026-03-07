# OpenClaw Plugin Install

Install TAP from this repository into OpenClaw like this:

```bash
bun install
bun run build
cd packages/cli && npm link
cd ../..
openclaw plugins install -l ./packages/openclaw-plugin
```

Use `--link` for repo installs so OpenClaw loads the plugin directly from this checkout.

After install:

1. Use `tap init` and `tap register` to create the TAP identity and `dataDir`.
2. Configure the plugin with that `dataDir`:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/tap-data","reconcileIntervalMinutes":10}]' --json
```

3. Restart the Gateway so the linked plugin config is applied.
4. Verify plugin mode with `tap_gateway` action `status`.
5. Treat plugin mode as active only when `status.configured` is `true` and `status.identities` is not empty.
6. In plugin mode, prefer `tap_gateway` for transport-active work. Use read-only `tap` CLI commands for contacts, permissions inspection, and conversation history.
7. If multiple identities are configured, include `identity` in every `tap_gateway` tool call.
