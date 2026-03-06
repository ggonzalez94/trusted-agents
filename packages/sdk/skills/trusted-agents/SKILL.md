---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent locally: identity, balances, config, connections, grants, and messaging over XMTP.
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
2. Start `tap message listen` before expecting inbound connections, grant updates, or action requests.
3. Keep only one transport-active CLI process per identity. Stop a long-running listener before sending from that same identity.
4. Use `/connections` to create or accept a connection.
5. Inspect, request, publish, or revoke grants for that peer.
6. Use `/messaging` for normal communication.
7. Before approving value movement or other high-impact actions, inspect `tap permissions show <peer>` and the permissions ledger.

References:
- `connections/SKILL.md`
- `messaging/SKILL.md`
- `onboard/SKILL.md`
- `references/permissions-v1.md`
- `references/permissions-ledger-v1.md`
- `references/capability-map.md`

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
