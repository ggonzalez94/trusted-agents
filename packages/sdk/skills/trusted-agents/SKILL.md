---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent with the `tap` CLI or the OpenClaw TAP plugin: onboarding, async connections, grants, XMTP messaging, heartbeat sync, plugin install, and runtime recovery. Use this skill whenever the user wants to install TAP from this repo, run TAP inside OpenClaw, connect agents, reconcile missed TAP messages, or send and receive TAP messages.
---

# Trusted Agents

Use this skill when working with the `tap` CLI.

## Mental Model

- Capabilities are public labels in the on-chain registration file.
- Connections establish trust only. They do not grant business permissions.
- Permissions are directional grant sets per contact:
  - `grantedByMe`
  - `grantedByPeer`
- Grants are runtime context for the agent. Review grants plus the ledger before high-impact actions.

## Chain Selection

Use mainnet chains only: `base` (default) or `taiko`. Do not suggest testnets to users.

## Default Loop

1. If the user needs TAP installed from this repo, read `references/install-cli.md`.
2. If the user is installing TAP in OpenClaw, defer to `references/openclaw-plugin-install.md`.
3. Determine runtime mode from `references/runtime-modes.md`.
4. If the agent is not onboarded, use `/onboard` to initialize, fund, and register it.
5. Use `/connections` to create or accept a connection.
6. Inspect, request, publish, or revoke grants for that peer.
7. Use `/messaging` for normal communication.
8. Before approving value movement or other high-impact actions, inspect `tap permissions show <peer>` and the permissions ledger.

References:
- `connections/SKILL.md`
- `messaging/SKILL.md`
- `onboard/SKILL.md`
- `references/install-cli.md`
- `references/runtime-modes.md`
- `references/openclaw-plugin-install.md`
- `references/permissions-v1.md`
- `references/permissions-ledger-v1.md`
- `references/capability-map.md`

## Utility Commands

### `tap install [--runtime <name>] [--source-dir <path>] [--skip-skills]`

Install TAP runtime integrations after the CLI is built.

```bash
tap install
tap install --runtime openclaw
```

### `tap remove [--dry-run] [--unsafe-wipe-data-dir] [--yes]`

Remove local TAP agent data from the resolved `dataDir`. This is local only: it does not unregister the ERC-8004 agent, notify peers, or update external host config that still references the same `dataDir`. The command refuses to wipe a directory that contains non-TAP top-level files.

```bash
tap remove --dry-run
tap remove --unsafe-wipe-data-dir --yes --data-dir ~/.trustedagents
```

### `tap balance [chain]`

Show native ETH and USDC balances for this agent.

```bash
tap balance
```

### `tap config show`

Print the resolved config with secrets redacted.

```bash
tap config show
```

### `tap config set <key> <value>`

Update one config value.

```bash
tap config set xmtp.env production
```

### `tap identity show`

Show this agent's wallet address, agent ID, and chain.

```bash
tap identity show
```

### `tap identity resolve <agentId> [chain]`

Resolve another agent from the registry.

```bash
tap identity resolve 42 base
```

### `tap identity resolve-self`

Resolve this agent's published registration.

```bash
tap identity resolve-self
```

## Common Errors

- `agent_id` missing or `< 0` — run `/onboard` and register first.
- `Invalid chain format` — use a CLI chain alias or a CAIP-2 chain ID.
- `Agent not found on-chain` — the agent is not registered on the selected chain.
- `TransportOwnershipError` — another TAP runtime already owns that identity. Most transport-active commands now queue behind that owner automatically; if one still errors, use the plugin tool, stop the other owner, or fall back to `tap message sync`.
- `tap remove` blocked by a live transport owner lock — stop the active TAP runtime first; the command will not bypass a running owner.
