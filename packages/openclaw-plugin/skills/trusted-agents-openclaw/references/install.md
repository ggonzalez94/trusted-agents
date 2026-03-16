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

`tap install --runtime openclaw` is the recommended managed install path for this repo:

```bash
tap install --runtime openclaw
```

OpenClaw uses the plugin-bundled skill tree. This path does not install the generic TAP skill tree into `~/.openclaw/skills`.

Installer behavior:

- If the managed OpenClaw Gateway service is already loaded, `tap install --runtime openclaw` stops it first, installs the plugin link, validates the OpenClaw config, then restores the managed service. On macOS LaunchAgent installs that restore path uses a forced `openclaw gateway install --force`.
- If a foreground or otherwise unmanaged OpenClaw Gateway process is already running, the installer refuses to proceed. Stop that Gateway process first, then rerun install.
- If a TAP-managed legacy `~/.openclaw/skills/trusted-agents` symlink exists, the installer removes it. OpenClaw plugin mode should use the plugin-bundled skill tree only.
- OpenClaw already allowlists the plugin during `plugins install`, so you do not need a separate `plugins.allow` step for this repo install path.

Low-level manual plugin link:

```bash
openclaw plugins install --link ./packages/openclaw-plugin
```

Use that raw OpenClaw command only if you intentionally want the low-level path. It does not run TAP's Gateway stop/restore logic and it does not clean up legacy `~/.openclaw/skills/trusted-agents` entries for you.

After install:

1. Onboard the TAP identity with `tap init` and `tap register`.
2. Configure one or more TAP identities in OpenClaw:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/tap-data","reconcileIntervalMinutes":10}]' --json
```

3. Restart the Gateway after plugin config changes. The initial plugin install handles service-managed restarts automatically; this restart is for later identity/config edits.
4. Verify the runtime with `tap_gateway` action `status`.
5. Use plugin mode only when `status.configured` is `true`, the `identities` list is non-empty, and `status.warnings` is empty.
6. If more than one identity is configured, include `identity` in each `tap_gateway` tool call.
7. For read-only `tap` CLI inspection in multi-identity mode, use the matching `dataDir` from `status.identities[]` and pass `--data-dir <path>`.
8. Use `tap_gateway` for transport-active operations once the plugin is active.
9. If the Gateway warns `No TAP identities are configured`, that is expected until step 2 is done; it is not an install race by itself.
