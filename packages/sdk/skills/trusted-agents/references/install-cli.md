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
- If a TAP-managed legacy `~/.openclaw/skills/trusted-agents` symlink exists from an older setup, the OpenClaw install path removes it so Gateway only sees the plugin-bundled TAP skill tree.
- The OpenClaw install path does not stop or restart the Gateway. OpenClaw's built-in config reload detects plugin changes and restarts the Gateway automatically.
- Onboarding happens with the `tap` CLI.
- For non-Gateway hosts, streaming is optional and should run under a real supervisor like `systemd`, `launchd`, Docker, or PM2.

## After install

1. Run `tap init`.
2. Fund the wallet.
3. Run `tap register`.
4. Choose runtime mode from `references/runtime-modes.md`.
