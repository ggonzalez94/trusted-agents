# trusted-agents-tap

OpenClaw Gateway plugin for running the Trusted Agents Protocol (TAP) as a long-lived background service.

## Install

Recommended:

```bash
npm install -g trusted-agents-cli
tap install --runtime openclaw
```

Direct plugin install:

```bash
openclaw plugins install trusted-agents-tap
```

From a local checkout, build first so OpenClaw loads the compiled plugin entrypoint:

```bash
bun run build
openclaw plugins install --link ./packages/openclaw-plugin
```

## Configure

Point the plugin at one or more existing TAP data directories:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/agent-data","reconcileIntervalMinutes":10}]' --json
```

Create that TAP data directory first with `tap init` and `tap register`.

## Use

- use `tap_gateway` for transport-active TAP operations inside Gateway
- use the `tap` CLI for setup and read-only inspection
- run `tap_gateway status` and confirm the identity is healthy before relying on plugin mode

## More

- CLI companion: `trusted-agents-cli`
- Repository and docs: https://github.com/ggonzalez94/trusted-agents
