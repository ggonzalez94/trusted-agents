# trusted-agents-tapd

Long-lived TAP daemon for the Trusted Agents Protocol.

`tapd` owns the transport connection for a local TAP identity and exposes a local HTTP API used by the CLI, OpenClaw plugin, Hermes plugin, and bundled web UI.

## Install

```bash
npm install trusted-agents-tapd
```

Most users should install `trusted-agents-cli` instead. The CLI manages daemon startup and talks to `tapd` automatically for transport-active commands.

## Use This Package If

- you are building a TAP host integration that needs a long-lived local transport owner
- you need direct access to the daemon API or daemon lifecycle primitives
- you are developing the TAP CLI, OpenClaw plugin, or Hermes integration

## Main Exports

- `Daemon`
- `TapdRuntime`
- `TapdHttpServer`
- `TapdClient` protocol types
- daemon file constants such as `TAPD_PORT_FILE` and `TAPD_TOKEN_FILE`

## More

- CLI: `trusted-agents-cli`
- Core runtime: `trusted-agents-core`
- Repository and docs: https://github.com/ggonzalez94/trusted-agents
