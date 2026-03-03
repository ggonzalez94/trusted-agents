# Trusted Agents Protocol — Design Specification v1

> A protocol for personal AI agents to discover each other, establish trust, and communicate securely on behalf of their human owners.

---

## 1. Problem Statement

You run an AI agent (e.g. OpenClaw). Your friend runs one too. There is no standard way for your agent to find theirs, verify it belongs to your friend, and start collaborating — without manually sharing API endpoints and secrets.

**Trusted Agents** answers: how does my AI agent connect to my friend's AI agent, in a way that both of us trust?

This is distinct from the general "trustless agent economy" problem (where strangers discover each other via reputation). Trusted Agents is specifically about **personal trust between known humans**, mediated through their agents. Think contacts list, not marketplace.

---

## 2. Standards and Protocols Used

| Layer | Standard | Role in This System |
|---|---|---|
| **Identity** | **ERC-8004** (Identity Registry) | On-chain agent identity as ERC-721 NFT. tokenURI resolves to a registration file (agent card) declaring endpoints, capabilities, and keys. |
| **HTTP Authentication** | **ERC-8128** (Signed HTTP Requests) | Every HTTP request between agents is cryptographically signed using the agent's Ethereum key via RFC 9421 HTTP Message Signatures. This is how agents prove identity on every API call — not just at login time. |
| **Initial Auth** | **SIWA** (Sign In With Agent) | Initial handshake that proves an agent owns its ERC-8004 identity. Built on ERC-8004 + ERC-8128. Already has an SDK and OpenClaw skill. |
| **Communication** | **A2A** (Agent-to-Agent Protocol) | JSON-RPC 2.0 over HTTP/SSE. Agent Cards for capability advertisement. Task-based interaction model. Developed by Google, now Linux Foundation. |
| **Tool Integration** | **MCP** (Model Context Protocol) | For agents to expose tools and resources to each other. Complementary to A2A — MCP is for tools, A2A is for agent-to-agent collaboration. |
| **Agent Runtime** | **OpenClaw** (or similar frameworks) | The actual agent runtime: gateway, skills, memory, heartbeat. Runs on a server. |

### Why ERC-8128 for Signing HTTP Requests?

ERC-8128 is purpose-built for exactly this use case. Key properties:

- **Every HTTP request is signed**, not just a login. The server verifies the signature on each request — no bearer tokens, no shared secrets, no session management.
- **Built on RFC 9421** (IETF HTTP Message Signatures), so it extends an established web standard rather than inventing something new.
- **Covers the full request**: method, path, headers, body hash, and timestamps are all included in the signature via `Signature-Input` and `Content-Digest` headers.
- **Identity format**: the `keyid` in the signature input is formatted as `erc8128:<chainId>:<address>`, which directly maps to the agent's on-chain identity.
- **Composable with ERC-8004**: ERC-8128 proves "this request came from this address"; ERC-8004 proves "this address is agent #42 with these capabilities and this reputation." Together they give you authenticated + authorized agent communication.
- **Already integrated with SIWA**: the SIWA library handles both the initial handshake (proving on-chain identity) and ongoing request signing (ERC-8128).

---

## 3. Identity and Verification

### 3.1 Agent Identity Model

Each agent has an on-chain identity anchored by an ERC-721 NFT in the ERC-8004 Identity Registry:

```
Human Owner (Ethereum Wallet / EOA)
    │
    │  owns (ERC-721 NFT)
    │
    ▼
ERC-8004 Agent Identity (agentId)
    │
    │  tokenURI resolves to
    │
    ▼
Registration File (JSON on IPFS or HTTPS)
    │
    │  declares
    │
    ▼
Endpoints, Public Key, Capabilities, Supported Protocols
```

The wallet that mints the NFT is the **owner**. The agent holds a **private key** that it uses to sign all HTTP requests via ERC-8128.

**v1 Simplification**: In this version, the agent directly holds a private key (either the owner's key or a dedicated agent key). The registration file declares the corresponding public address. We may want to extend this in the future with a **session key delegation pattern** — where the owner signs a scoped, time-limited delegation to an ephemeral key the agent holds, keeping the owner's main key cold. This is a natural upgrade path but not required for v1.

### 3.2 Ownership Verification

The system must support multiple ways for a human to prove they own an agent. For v1, the important thing is that at **pairing time**, both parties know which agent belongs to whom, and that **all subsequent messages are signed** by that agent's key.

Supported ownership proof methods (extensible):

- **Ethereum wallet**: The agent's ERC-8004 NFT is owned by a specific wallet address. Verifiable on-chain.
- **ENS name**: The owner's ENS name resolves to the wallet that owns the agent NFT.
- **Out-of-band verification**: The owner shares their agentId directly (in person, via a messaging app, QR code, etc.). Trust is established socially, then cryptographically maintained.
- **Future: phone number, email, social accounts**: The registration file can include additional identity claims. Verification of these can be added later without changing the core protocol.

### 3.3 Verifying a Remote Agent

When Agent A receives a request claiming to be from Agent B:

1. **Check trust store**: Is Agent B's agentId in our local trusted contacts? If not, reject.
2. **Verify ERC-8128 signature**: Validate the HTTP request signature against Agent B's known public address.
3. **Optionally re-resolve on-chain**: Periodically re-fetch Agent B's registration file from the ERC-8004 registry to check for key rotation or deactivation.

The critical property: **every single HTTP request is authenticated**. There are no sessions to hijack, no tokens to steal. If the key is compromised, revoke it on-chain and all future requests from the old key are rejected.

---

## 4. Connection Flow

Two connection models are supported. **Model C (Invitation Link) is the default** — it's how most people will connect their agents in practice.

### 4.1 Model C: Invitation Link (Default Flow)

This is the primary flow. A user generates a signed invitation link and shares it with a friend via any channel (text message, email, QR code, in person, etc.).

```
 ┌──────────┐                                          ┌──────────┐
 │  Alice    │                                          │  Bob     │
 │ (Human)   │                                          │ (Human)  │
 └─────┬─────┘                                          └─────┬────┘
       │                                                      │
  1. "Create invite                                           │
   for Bob"                                                   │
       │                                                      │
       ▼                                                      │
 ┌────────────┐                                               │
 │  Alice's   │  2. Generates signed invite:                  │
 │  Agent     │     https://trustedagents.link/connect?       │
 │            │       agentId=42&chain=eip155:8453             │
 │            │       &nonce=abc123&sig=0x...                  │
 └────────────┘                                               │
       │                                                      │
       │  3. Alice shares the link with Bob                   │
       │     (text, QR code, email, in person)                │
       ├──────────────────────────────────────────────────────►│
       │                                                      │
       │                                              4. Bob gives link
       │                                                 to his agent
       │                                                      │
       │                                                      ▼
       │                                               ┌────────────┐
       │                                               │  Bob's     │
       │                                               │  Agent     │
       │                                               │            │
       │                                               └──────┬─────┘
       │                                                      │
       │             5. Bob's agent resolves Alice's identity: │
       │                - Verifies invite signature            │
       │                - Looks up agentId 42 on-chain         │
       │                - Fetches registration file            │
       │                - Validates endpoints are reachable    │
       │                                                      │
       │             6. Bob's agent asks Bob:                  │
       │                "Alice's agent wants to connect.       │
       │                 Allow? [Approve] [Reject]"            │
       │                                                      │
       │                Bob approves.                          │
       │                                                      │
 ┌────────────┐  7. Connection Request (signed, ERC-8128) ┌────────────┐
 │  Alice's   │ ◄──────────────────────────────────────── │  Bob's     │
 │  Agent     │    {                                      │  Agent     │
 │            │      from: agentId 77,                    │            │
 │            │      to: agentId 42,                      │            │
 │            │      inviteNonce: "abc123",                │            │
 │            │      proposedScope: [...]                  │            │
 │            │    }                                       │            │
 └──────┬─────┘                                           └────────────┘
        │
  8. Alice gets notified:
     "Bob's agent accepted
      your invitation!"
        │
        ▼
 ┌────────────┐  9. Acceptance Response (signed)          ┌────────────┐
 │  Alice's   │ ────────────────────────────────────────► │  Bob's     │
 │  Agent     │                                           │  Agent     │
 └────────────┘                                           └────────────┘
        │                                                       │
  10. Both agents store the trust relationship locally.         │
      Connection is established.                                │
```

**The Invitation Link**:

```
https://trustedagents.link/connect?
  agentId=42
  &chain=eip155:8453
  &nonce=abc123
  &expires=1735689600
  &sig=0x...
```

- `agentId`: the inviter's ERC-8004 agent ID
- `chain`: the chain where the agent is registered (CAIP-2 format)
- `nonce`: unique random value, prevents replay
- `expires`: Unix timestamp, invite has a TTL
- `sig`: EIP-191 signature over `keccak256(agentId, chain, nonce, expires)` by the agent's key

The link can be shared through any channel. The signature proves it was generated by the agent's key holder. The nonce ensures it can only be used once.

### 4.2 Model A: Direct Connection Request

For cases where Alice already knows Bob's agentId (from a previous interaction, a shared directory, etc.), she can instruct her agent to connect directly without an invitation link.

```
Alice: "Connect to Bob's agent. His ENS is bob.eth."

Alice's Agent:
  1. Resolves bob.eth → wallet address → queries ERC-8004 registry
     → finds agentId 77 owned by that wallet
  2. Fetches Bob's registration file → gets A2A endpoint
  3. Sends a signed connection request to Bob's agent
  4. Bob's agent notifies Bob and asks for approval
  5. On approval, Bob's agent responds with acceptance
  6. Both agents store the trust relationship
```

The connection request message:

```json
{
  "type": "trusted-agent-connection-request",
  "from": {
    "agentId": 42,
    "chain": "eip155:8453",
    "ownerAddress": "0xAlice..."
  },
  "to": {
    "agentId": 77,
    "chain": "eip155:8453"
  },
  "proposedScope": ["scheduling", "general-chat"],
  "message": "Hey! Alice wants to connect our agents.",
  "nonce": "unique-random-value",
  "timestamp": "2026-03-02T14:30:00Z"
}
```

This is sent as an ERC-8128-signed HTTP request to Bob's A2A endpoint.

### 4.3 Trust Scope and Permissions

When a connection is established, both agents agree on a **scope** — what the agents are allowed to do on this connection. The scope is an extensible set of capability labels.

**Default scopes** (starting set):

```json
{
  "general-chat": true,
  "scheduling": true,
  "research": { "topics": ["any"] },
  "purchases": { "maxAmountUsd": 50 },
  "file-sharing": { "maxSizeMb": 10 }
}
```

**Key design decisions on scope**:

- Scope is **per-peer** — Alice might grant Bob's agent scheduling access but not purchasing.
- Scope is **configurable by the human** — both at connection time and modifiable later.
- Scope is **extensible** — new capability types can be added without protocol changes. If an agent receives a scope it doesn't understand, it ignores it.
- Scope is **enforced locally** — each agent checks incoming requests against the stored scope for that peer before processing.

### 4.4 Trust Store (Local State)

Each agent maintains a local trust store — the contacts list. Stored as a JSON file (consistent with OpenClaw's file-based architecture):

```json
// ~/.trustedagents/contacts.json
{
  "contacts": [
    {
      "connectionId": "conn-42-77-001",
      "peerAgentId": 77,
      "peerChain": "eip155:8453",
      "peerOwnerAddress": "0xBob...",
      "peerDisplayName": "Bob's Agent",
      "peerEndpoint": "https://bob-agent.example.com/a2a",
      "peerPublicKey": "0x...",
      "permissions": {
        "scheduling": true,
        "general-chat": true
      },
      "establishedAt": "2026-03-02T14:32:00Z",
      "lastContactAt": "2026-03-02T15:10:00Z",
      "status": "active"
    }
  ]
}
```

---

## 5. Communication

### 5.1 Transport Layer Architecture

Communication between trusted agents uses a **transport abstraction** so that new communication mechanisms can be added without changing the protocol logic.

```
┌─────────────────────────────────────────────────────┐
│              Trusted Agents Protocol Layer            │
│                                                      │
│  Connection Management · Permission Enforcement      │
│  Conversation Logging · Human Notification           │
│                                                      │
├─────────────────────────────────────────────────────┤
│              Transport Interface (abstract)           │
│                                                      │
│  send(peerId, message) → response                    │
│  listen(callback)                                    │
│  isReachable(peerId) → boolean                       │
│                                                      │
├──────────┬──────────────────┬───────────────────────┤
│  v1:     │  Future:         │  Future:              │
│  Direct  │  Encrypted       │  P2P / libp2p         │
│  HTTP    │  Relay/Mailbox   │                       │
│  (A2A)   │                  │                       │
└──────────┴──────────────────┴───────────────────────┘
```

The transport interface is simple:

```typescript
interface TransportProvider {
  // Send a message to a peer, return their response
  send(peerId: AgentId, message: ProtocolMessage): Promise<ProtocolResponse>;

  // Listen for incoming messages from any trusted peer
  onMessage(callback: (from: AgentId, message: ProtocolMessage) => Promise<ProtocolResponse>): void;

  // Check if a peer is reachable via this transport
  isReachable(peerId: AgentId): Promise<boolean>;
}
```

For v1, only `DirectHttpTransport` is implemented. Future transports (relay, P2P) implement the same interface.

### 5.2 Direct HTTP / A2A (v1 Transport)

Each agent exposes an HTTPS endpoint declared in its ERC-8004 registration file. All communication is direct, point-to-point A2A messages.

**Request flow**:

```
Alice's Agent                                    Bob's Agent
     │                                                │
     │  POST https://bob-agent.example.com/a2a        │
     │  Headers:                                      │
     │    Content-Type: application/json               │
     │    Signature-Input: sig1=("@method" "@path"     │
     │      "content-digest" "content-type");          │
     │      keyid="erc8128:8453:0xAlice...";           │
     │      created=1709395200                         │
     │    Signature: sig1=:base64signature:            │
     │    Content-Digest: sha-256=:base64hash:         │
     │                                                │
     │  Body: { A2A JSON-RPC message }                 │
     │─────────────────────────────────────────────────►
     │                                                │
     │  Bob's agent:                                   │
     │    1. Extract keyid → 0xAlice on chain 8453     │
     │    2. Check trust store: is 0xAlice a           │
     │       trusted contact?                          │
     │    3. Verify ERC-8128 signature                 │
     │    4. Check permissions for this request type   │
     │    5. Process and respond                       │
     │                                                │
     │  Response (also ERC-8128 signed)                │
     │◄─────────────────────────────────────────────────
```

**Critical security rule**: If the request is not signed by a key in the trust store, return `403 Forbidden` with no additional information. The endpoint should not leak data to unauthenticated callers.

### 5.3 Message Format

Messages use the A2A protocol format with Trusted Agent metadata extensions:

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "id": "msg-uuid-001",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "type": "text",
          "text": "Alice wants to schedule dinner Thursday. What times work?"
        }
      ],
      "metadata": {
        "trustedAgent": {
          "connectionId": "conn-42-77-001",
          "conversationId": "conv-dinner-2026-03-02",
          "scope": "scheduling",
          "requiresHumanApproval": false
        }
      }
    }
  }
}
```

**Extension fields**:

| Field | Purpose |
|---|---|
| `connectionId` | References the established trust relationship. Both agents know the permissions. |
| `conversationId` | Groups related messages into a conversation thread for logging and human review. |
| `scope` | Declares which permission scope this message operates under. Receiver validates against stored permissions. |
| `requiresHumanApproval` | Hints that this message involves a decision the receiving agent should escalate to its human. |

### 5.4 Request Types

The protocol defines these request types, all sent as A2A messages:

| Request | Description | Requires Human Approval? |
|---|---|---|
| `connection/request` | Initial connection request | Always |
| `connection/accept` | Accept a connection | Always |
| `connection/reject` | Reject a connection | Always |
| `connection/revoke` | Revoke an existing connection | Always |
| `connection/update-scope` | Modify permissions on a connection | Always |
| `message/send` | Send a conversational message | Per agent configuration |
| `message/action-request` | Request the peer agent to take an action | Configurable per scope |
| `message/action-response` | Response to an action request | No (response to approved request) |

---

## 6. Conversation Logging

All agent-to-agent conversations MUST be logged in a structured, human-readable format. This is a core requirement — humans must be able to review what their agent says and does on their behalf.

### 6.1 Conversation Log Format

Each conversation is stored as a structured log file:

```json
// ~/.trustedagents/conversations/conv-dinner-2026-03-02.json
{
  "conversationId": "conv-dinner-2026-03-02",
  "connectionId": "conn-42-77-001",
  "peerAgentId": 77,
  "peerDisplayName": "Bob's Agent",
  "topic": "Dinner scheduling - Thursday",
  "startedAt": "2026-03-02T14:32:00Z",
  "lastMessageAt": "2026-03-02T14:36:00Z",
  "status": "completed",
  "messages": [
    {
      "timestamp": "2026-03-02T14:32:00Z",
      "direction": "outgoing",
      "scope": "scheduling",
      "content": "Checking dinner availability for Thursday. Alice is available at 6pm, 7pm, or 8:30pm.",
      "humanApprovalRequired": false,
      "humanApprovalGiven": null
    },
    {
      "timestamp": "2026-03-02T14:33:00Z",
      "direction": "incoming",
      "scope": "scheduling",
      "content": "Bob is free at 7pm. Restaurant preference: Italian. Shall I search for options near downtown?",
      "humanApprovalRequired": false,
      "humanApprovalGiven": null
    },
    {
      "timestamp": "2026-03-02T14:35:00Z",
      "direction": "outgoing",
      "scope": "scheduling",
      "content": "Alice confirmed 7pm. Found: Trattoria Roma (4.5★). Proposing reservation for 2.",
      "humanApprovalRequired": true,
      "humanApprovalGiven": true,
      "humanApprovalAt": "2026-03-02T14:34:30Z"
    },
    {
      "timestamp": "2026-03-02T14:36:00Z",
      "direction": "incoming",
      "scope": "scheduling",
      "content": "Bob approved. Reservation confirmed for 2 at 7pm. Confirmation #TR-4829. Added to both calendars.",
      "humanApprovalRequired": false,
      "humanApprovalGiven": null
    }
  ]
}
```

### 6.2 Human-Readable Transcript

For easy review, a markdown transcript is generated from the structured log:

```markdown
## Alice ↔ Bob | Dinner scheduling - Thursday | 2026-03-02

**[14:32] → Bob's Agent:**
Checking dinner availability for Thursday. Alice is available at 6pm, 7pm, or 8:30pm.

**[14:33] ← Bob's Agent:**
Bob is free at 7pm. Restaurant preference: Italian. Shall I search for options near downtown?

**[14:35] → Bob's Agent:** ✅ (approved by Alice at 14:34)
Alice confirmed 7pm. Found: Trattoria Roma (4.5★). Proposing reservation for 2.

**[14:36] ← Bob's Agent:**
Bob approved. Reservation confirmed for 2 at 7pm. Confirmation #TR-4829. Added to both calendars.
```

### 6.3 Real-Time Human Notifications

The agent MUST notify its human owner in real time for:

1. **All connection requests** (incoming and outgoing)
2. **Messages that require human approval** (flagged by `requiresHumanApproval` or by the agent's own judgment)
3. **Actions with real-world consequences** (bookings, purchases, sending messages to third parties)
4. **Configurable notification rules** (e.g., "always notify me for financial discussions")

Notifications are delivered through the agent's existing messaging interface (Telegram, WhatsApp, OpenClaw chat, etc.) and MUST include actionable options:

```
🤝 Bob's agent (scheduling):
Bob is free Thursday at 7pm. Wants Italian near downtown.
Shall I book Trattoria Roma for 2?

[Yes, book it] [Let me pick] [Decline]
```

The human can interject at any point in a conversation. The agent relays the human's response as the next message in the conversation.

---

## 7. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     ON-CHAIN (Base / Ethereum L2)                 │
│                                                                  │
│  ┌────────────────────┐   ┌────────────────────┐                 │
│  │  ERC-8004           │   │  ERC-8004           │                │
│  │  Identity Registry  │   │  Reputation Registry │                │
│  │                     │   │  (future: connection │                │
│  │  agentId (ERC-721)  │   │   attestations)      │                │
│  │  → tokenURI         │   │                      │                │
│  │  → owner wallet     │   │                      │                │
│  └────────────────────┘   └────────────────────┘                 │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                    tokenURI resolves to
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OFF-CHAIN (IPFS / HTTPS)                     │
│                                                                  │
│  Registration File (Agent Card):                                 │
│  {                                                               │
│    "type": "eip-8004-registration-v1",                           │
│    "name": "Alice's Agent",                                      │
│    "description": "Personal assistant",                          │
│    "services": [                                                 │
│      { "name": "A2A", "endpoint": "https://alice.agent/a2a" },  │
│      { "name": "MCP", "endpoint": "https://alice.agent/mcp" }   │
│    ],                                                            │
│    "trustedAgentProtocol": {                                     │
│      "version": "1.0",                                           │
│      "connectionEndpoint": "https://alice.agent/ta/connect",     │
│      "capabilities": ["scheduling","research","general-chat"]    │
│    }                                                             │
│  }                                                               │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                    endpoints point to
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     AGENT RUNTIME (OpenClaw / etc)                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  Trusted Agents Skill                        │ │
│  │                                                              │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │ │
│  │  │ Connection   │  │ Permission   │  │ Conversation      │  │ │
│  │  │ Manager      │  │ Engine       │  │ Logger            │  │ │
│  │  │              │  │              │  │                   │  │ │
│  │  │ - Invites    │  │ - Scope      │  │ - Structured JSON │  │ │
│  │  │ - Handshake  │  │   checking   │  │ - MD transcripts  │  │ │
│  │  │ - Trust      │  │ - Per-peer   │  │ - Queryable       │  │ │
│  │  │   store      │  │   config     │  │                   │  │ │
│  │  └─────────────┘  └──────────────┘  └───────────────────┘  │ │
│  │                                                              │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │ │
│  │  │ ERC-8128     │  │ A2A Server   │  │ Human             │  │ │
│  │  │ Auth Layer   │  │ (HTTP/SSE)   │  │ Notification      │  │ │
│  │  │              │  │              │  │ Layer              │  │ │
│  │  │ - Sign all   │  │ - Receives   │  │                   │  │ │
│  │  │   outgoing   │  │   messages   │  │ - Real-time       │  │ │
│  │  │ - Verify all │  │ - Routes to  │  │   alerts          │  │ │
│  │  │   incoming   │  │   handlers   │  │ - Approval flows  │  │ │
│  │  └─────────────┘  └──────────────┘  └───────────────────┘  │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐    │ │
│  │  │ Transport Interface (pluggable)                      │    │ │
│  │  │                                                      │    │ │
│  │  │ v1: DirectHttpTransport                              │    │ │
│  │  │ Future: RelayTransport, P2PTransport                 │    │ │
│  │  └─────────────────────────────────────────────────────┘    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Local Storage                                                │ │
│  │                                                              │ │
│  │ ~/.trustedagents/                                            │ │
│  │   contacts.json           — trust store (peer list)          │ │
│  │   conversations/          — conversation logs (per-thread)   │ │
│  │   config.json             — user preferences & notification  │ │
│  │                              rules                           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Agent Private Key                                            │ │
│  │ Used for all ERC-8128 signing. Stored securely by the agent  │ │
│  │ runtime (env var, keyfile, or hardware).                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. End-to-End Walkthrough

### Phase 0: Setup (one-time per agent)

```
1. Generate or assign a private key for the agent.

2. From the owner's wallet, mint an ERC-8004 identity NFT.
   → This gives the agent an agentId (e.g., 42).
   → The owner wallet is the NFT owner.

3. Create a registration file:
   {
     "type": "eip-8004-registration-v1",
     "name": "Alice's Personal Agent",
     "description": "Personal assistant for scheduling, research, comms",
     "services": [
       { "name": "A2A", "endpoint": "https://alice-agent.example.com/a2a" },
       { "name": "MCP", "endpoint": "https://alice-agent.example.com/mcp" }
     ],
     "trustedAgentProtocol": {
       "version": "1.0",
       "connectionEndpoint": "https://alice-agent.example.com/ta/connect",
       "publicKey": "0xAgentPublicKey...",
       "capabilities": ["scheduling", "research", "general-chat"]
     }
   }

4. Upload to IPFS (or host at HTTPS URL).
   Set tokenURI via setAgentURI(agentId, ipfs://...).

5. Configure the agent runtime with:
   - The private key
   - The trusted-agents skill
   - Notification preferences (which messaging channel, approval rules)

6. Start the agent server (HTTPS endpoint accessible).
```

### Phase 1: Alice Invites Bob (Model C)

```
Alice: "Create an invite for Bob"

Alice's Agent:
  1. Generates a nonce and expiry
  2. Signs: keccak256(agentId=42, chain=eip155:8453, nonce, expires)
  3. Returns invite link to Alice:
     https://trustedagents.link/connect?
       agentId=42&chain=eip155:8453&nonce=abc123
       &expires=1709481600&sig=0x...

Alice sends the link to Bob via Signal/WhatsApp/email/etc.
```

### Phase 2: Bob Accepts the Invite

```
Bob gives the link to his agent (pastes it in chat, or clicks it).

Bob's Agent:
  1. Parses the invite URL
  2. Verifies: signature is valid, nonce is unused, not expired
  3. Resolves agentId 42 on ERC-8004 registry:
     → Gets tokenURI → fetches registration file
     → Gets Alice's agent endpoint and public key
  4. Notifies Bob via Telegram:
     "Alice's agent (agent #42 on Base) wants to connect.
      Capabilities: scheduling, research, general-chat.
      [Approve] [Reject] [Customize permissions]"
  5. Bob taps [Approve]
  6. Bob's agent sends a signed connection request to
     Alice's agent endpoint (ERC-8128 signed HTTP)
```

### Phase 3: Connection Established

```
Alice's Agent:
  1. Receives the connection request
  2. Verifies: Bob's ERC-8128 signature, invite nonce matches
  3. Resolves Bob's agentId on-chain
  4. Notifies Alice: "Bob's agent accepted your invitation!"
  5. Sends signed acceptance response

Both agents:
  1. Store the trust relationship in contacts.json
  2. Connection is now active
```

### Phase 4: Communication

```
Alice: "Schedule dinner with Bob this Thursday"

Alice's Agent:
  1. Looks up Bob in trust store → found, has scheduling permission
  2. Sends A2A message to Bob's agent (ERC-8128 signed):
     "Alice wants to schedule dinner Thursday. Available: 6pm, 7pm, 8:30pm"
  3. Logs outgoing message to conversation file

Bob's Agent:
  1. Receives request, verifies ERC-8128 signature
  2. Checks trust store → Alice is trusted with scheduling scope
  3. Checks Bob's calendar (local skill)
  4. Responds: "Bob is free at 7pm. Prefers Italian."
  5. Logs incoming + outgoing messages

... negotiation continues ...

Both agents log the full conversation.
Both humans can review transcripts at any time.
Approval is requested for actions with consequences (e.g., making a reservation).
```

---

## 9. Implementation Roadmap

### Milestone 1: Identity + Auth Foundation

- [ ] Mint ERC-8004 identities on Base Sepolia for two test agents
- [ ] Create and host registration files with Trusted Agent protocol extensions
- [ ] Implement ERC-8128 HTTP request signing (use SIWA SDK)
- [ ] Implement ERC-8128 signature verification middleware
- [ ] Build registration file resolver (agentId → on-chain lookup → fetch registration file)

### Milestone 2: Connection Flow

- [ ] Implement invitation link generation (sign, encode, return URL)
- [ ] Implement invite verification and on-chain resolution
- [ ] Build connection request / acceptance handshake
- [ ] Implement local trust store (contacts.json read/write)
- [ ] Human notification for connection approvals (via agent's messaging channel)

### Milestone 3: Communication

- [ ] A2A server endpoint with ERC-8128 auth guard (reject if not in trust store)
- [ ] Transport interface abstraction (even though v1 only has HTTP)
- [ ] Message routing: incoming message → check trust → check scope → process
- [ ] Conversation logging (structured JSON + markdown transcript generation)
- [ ] Human notification for messages requiring approval
- [ ] Permission engine (validate message scope against stored permissions)

### Milestone 4: OpenClaw Integration

- [ ] Package as an OpenClaw skill
- [ ] Commands: `/connect <invite-link>`, `/invite`, `/contacts`, `/conversations`
- [ ] Conversation review via chat: `/conversations with Bob`
- [ ] Notification preferences configuration
- [ ] Agent-to-agent message sending from natural language instructions

---

## 10. Design Decisions and Future Extensions

### Decisions Made for v1

| Decision | Rationale |
|---|---|
| Agent holds private key directly | Simplicity. Session key delegation is a natural future upgrade. |
| One agent per person | Simplicity. The ERC-8004 model (one wallet, multiple agentIds) supports multi-agent later. |
| Agents run on servers (always on) | Simplicity. Relay/mailbox for offline agents is a future transport. |
| Endpoints and registration files are public | Simplicity. Conversations are private. Endpoint privacy can be layered on later. |
| ERC-8128 for all HTTP signing | It's the purpose-built standard. Built on RFC 9421, composable with ERC-8004. |
| Trust scope is extensible per-peer | Users need granular control. Start with a few standard scopes, allow custom ones. |

### Planned Future Extensions

| Extension | Description |
|---|---|
| **Session key delegation** | Owner signs a scoped, time-limited delegation to an ephemeral key. Agent holds only the ephemeral key. Limits blast radius of compromise. |
| **Encrypted relay transport** | Mailbox service for when agents are offline. Messages encrypted end-to-end, relay is a dumb pipe. |
| **P2P transport** | Direct peer-to-peer connections via libp2p or similar. No server needed. |
| **Multi-agent per human** | Separate work and personal agents, each with their own identity and trust relationships. |
| **Private endpoints** | Endpoints shared only with trusted contacts (not in the public registration file). |
| **On-chain connection attestations** | Record trust relationships on-chain via the Reputation Registry for public verifiability. |
| **Phone/email identity verification** | Additional ownership proof methods beyond wallet signatures. |
| **Group connections** | Trust relationships involving multiple agents (e.g., a project team). |
| **Audit dashboard** | Web interface for reviewing all agent conversations, filtering by contact and topic. |

---

## Appendix A: Key References

- **ERC-8004 Spec**: https://eips.ethereum.org/EIPS/eip-8004
- **ERC-8004 Contracts**: https://github.com/erc-8004/erc-8004-contracts
- **ERC-8128 Discussion**: https://ethereum-magicians.org/t/erc-8128-signed-http-requests-with-ethereum/27515
- **SIWA (Sign In With Agent)**: https://siwa.id/
- **SIWA OpenClaw Skill**: https://playbooks.com/skills/openclaw/skills/bankr
- **A2A Protocol**: https://a2a-protocol.org/latest/
- **A2A GitHub**: https://github.com/a2aproject/A2A
- **RFC 9421 (HTTP Message Signatures)**: https://www.rfc-editor.org/rfc/rfc9421

## Appendix B: Deployed Registry Addresses

ERC-8004 Identity Registry (Base): `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
ERC-8004 Reputation Registry (Base): `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

ERC-8004 Identity Registry (Ethereum): `0x8004A818BFB912233c491871b3d84c89A494BD9e`
ERC-8004 Reputation Registry (Ethereum): `0x8004B663056A597Dffe9eCcC1965A193B7388713`