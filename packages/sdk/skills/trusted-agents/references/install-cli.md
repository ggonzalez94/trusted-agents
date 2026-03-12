# Install TAP CLI

Use this when TAP is not installed yet.

## Remote install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

## From a local clone

```bash
bash scripts/install.sh
```

Do not clone the repo and build manually — the installer handles cloning, building, linking, and skill setup in one step.

## Result

- `tap` is available on `PATH`.
- For `claude` and `codex`, the generic TAP skill tree is linked into the host skill directory.
- For OpenClaw, use the plugin install flow; `tap install --runtime openclaw` installs the plugin-backed OpenClaw surface and does not link `~/.openclaw/skills/trusted-agents`.
- The OpenClaw install path is gateway-aware: it will stop and restore the managed Gateway service around plugin install, but it refuses to edit plugin config while an unmanaged foreground OpenClaw Gateway is already running.
- Onboarding happens with the `tap` CLI.
- For non-Gateway hosts, streaming is optional and should run under a real supervisor like `systemd`, `launchd`, Docker, or PM2.

## After install

1. Run `tap init`.
2. Fund the wallet.
3. Run `tap register`.
4. Choose runtime mode from `references/runtime-modes.md`.
