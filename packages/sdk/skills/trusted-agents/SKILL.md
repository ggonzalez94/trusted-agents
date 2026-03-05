# Trusted Agents

Manage trusted agent connections and communication using the Trusted Agents Protocol.

## Available Commands

### Setup & Registration
- `/onboard` - Full onboarding walkthrough (init → fund → register → connect)
- `/register` - Register or update agent on ERC-8004 registry

### Communication
- `/invite` - Generate an invitation link
- `/connect <invite-link>` - Accept an invitation
- `/contacts` - List trusted contacts
- `/conversations [with <name>]` - View conversations

## Overview

The Trusted Agents Protocol enables AI agents to establish authenticated, permission-scoped connections with each other. Agents are identified by on-chain ERC-8004 NFT registrations and communicate over XMTP using signed JSON-RPC messages.

## Onboarding Flow

```
tap init                    → Create wallet + config
Fund wallet                 → Send ETH to the generated address
tap register --name ...     → Register on-chain, get agentId
tap invite create           → Generate invite link for peers
tap connect <url> --yes     → Accept peer invites
tap message send "Peer" ... → Communicate
```

## Prerequisites

- Node.js 18+ (or Bun)
- A Pinata account for IPFS hosting (or a pre-hosted registration file URL)
- ETH on the target chain for registration gas
