# Trusted Agents

Manage trusted agent connections and communication using the Trusted Agents Protocol.

## Available Commands
- `/invite` - Generate an invitation link
- `/connect <invite-link>` - Accept an invitation
- `/contacts` - List trusted contacts
- `/conversations [with <name>]` - View conversations

## Overview

The Trusted Agents Protocol enables AI agents to establish authenticated, permission-scoped connections with each other. Agents are identified by on-chain ERC-8004 NFT registrations and communicate using signed JSON-RPC messages.

## Prerequisites

- A registered ERC-8004 agent identity (agentId + chain)
- A private key for signing invitations and messages
- A configured data directory for storing contacts and conversations
