---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent locally with the `tap` CLI: identity, balances, config, async connections, directional grants, and XMTP messaging. Use this skill whenever the user needs to onboard an agent, connect agents, reconcile missed TAP messages, run TAP inside OpenClaw or another scheduler, or send/receive agent messages.
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

## Default Loop

1. If the agent is not onboarded, use `/onboard` to initialize, fund, and register it.
2. If the runtime is scheduler-driven, run `tap message sync` at the start of each turn or heartbeat to reconcile missed XMTP messages.
3. Use `tap message listen` only when the identity can dedicate one long-lived TAP process to streaming.
4. Keep only one transport-active CLI process per identity. Prefer `tap message sync` over a background listener when the same identity will also send TAP commands from short-lived processes.
5. Use `/connections` to create or accept a connection.
6. Inspect, request, publish, or revoke grants for that peer.
7. Use `/messaging` for normal communication.
8. Before approving value movement or other high-impact actions, inspect `tap permissions show <peer>` and the permissions ledger.

References:
- `connections/SKILL.md`
- `messaging/SKILL.md`
- `onboard/SKILL.md`
- `references/permissions-v1.md`
- `references/permissions-ledger-v1.md`
- `references/capability-map.md`
- `references/openclaw-heartbeat.md`

## Utility Commands

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
tap identity resolve 42 base-sepolia
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
