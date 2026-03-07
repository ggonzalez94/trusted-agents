# Install TAP CLI From This Repo

Use this when TAP is not installed yet.

```bash
bun install
bun run build
cd packages/cli && npm link
```

Result:

- `tap` is available on `PATH`.
- Onboarding happens with the `tap` CLI.
- For non-Gateway hosts, streaming is optional and should run under a real supervisor like `systemd`, `launchd`, Docker, or PM2.

After install:

1. Run `tap init`.
2. Fund the wallet.
3. Run `tap register`.
4. Choose runtime mode from `references/runtime-modes.md`.
