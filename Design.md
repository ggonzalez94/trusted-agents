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
| **HTTP Authentication** | **ERC-8128** (Signed HTTP Requests) | Every HTTP request between agents is cryptographically signed using the agent's Ethereum key via RFC 9421 HTTP Message Signatures. This is how agents prove identity on every API call — not just at login time. Implemented directly with ethers.js/viem. |
| **Communication** | **A2A v0.3.0** (Agent-to-Agent Protocol) | JSON-RPC 2.0 over HTTP/SSE. Agent Cards for capability advertisement. Task-based interaction model. Developed by Google, now Linux Foundation. **Note**: v0.3.0 is the latest released version and is pinned for v1 MVP stability. |
| **Agent Runtime** | **OpenClaw** (or similar frameworks) | The actual agent runtime: gateway, skills, memory, heartbeat. Runs on a server. |

### Why ERC-8128 for Signing HTTP Requests?

ERC-8128 is purpose-built for exactly this use case. Key properties:

- **Every HTTP request is signed**, not just a login. The server verifies the signature on each request — no bearer tokens, no shared secrets, no session management.
- **Built on RFC 9421** (IETF HTTP Message Signatures), so it extends an established web standard rather than inventing something new.
- **Covers the full request**: method, path, headers, body hash, and timestamps are all included in the signature via `Signature-Input` and `Content-Digest` headers.
- **Identity format**: the `keyid` in the signature input is formatted as `erc8128:<chainId>:<address>`, which directly maps to the agent's on-chain identity.
- **Composable with ERC-8004**: ERC-8128 proves "this request came from this address"; ERC-8004 proves "this address is agent #42 with these capabilities." Together they give you authenticated + authorized agent communication.
- **No additional auth layer needed**: ERC-8128 handles both proving identity and authenticating every request. No separate handshake protocol, SDK, or session management is required — just ethers.js/viem and RFC 9421.

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

**v1 Requirement**: The agent can use its own private key, including for registration. Security is not our main concern for this release. We can add session keys and delegation later

The registration file declares the agent's public address via the `agentAddress` field in `trustedAgentProtocol`. Peers verify ERC-8128 signatures against this address.

**Future upgrade**: A **session key delegation pattern** — where the owner signs a scoped, time-limited delegation to an ephemeral key — is a natural extension but not required for v1.

### 3.2 Ownership Verification

The system must support multiple ways for a human to prove they own an agent. For v1, the important thing is that at **pairing time**, both parties know which agent belongs to whom, and that **all subsequent messages are signed** by that agent's key.

Supported ownership proof methods (extensible):

- **Ethereum wallet**: The agent's ERC-8004 NFT is owned by a specific wallet address. Verifiable on-chain.
- **ENS name**: The owner's ENS name resolves to the wallet that owns the agent NFT.
- **Out-of-band verification**: The owner shares their agentId directly (in person, via a messaging app, QR code, etc.). Trust is established socially, then cryptographically maintained. This is the main and default model we wanna build for v1.
- **Future: phone number, email, social accounts**: The registration file can include additional identity claims. Verification of these can be added later without changing the core protocol.

### 3.3 Verifying a Remote Agent

When Agent A receives a request claiming to be from Agent B:

1. **Check trust context**:
   - For normal message methods (`message/*`, `connection/revoke`, `connection/update-scope`), Agent B MUST already be in the trust store.
   - For bootstrap methods (`connection/request`, `connection/accept`, `connection/reject`), Agent B may be pre-trust, but the request MUST match a valid handshake context (for example: unexpired invite nonce or a pending local connection approval flow).
2. **Verify ERC-8128 signature**: Validate the HTTP request signature against Agent B's known or freshly resolved public address.
3. **Re-resolve on-chain** (mandatory): Re-fetch Agent B's registration file from the ERC-8004 registry at a configurable interval (recommended: every 24 hours) to check for key rotation or deactivation. **Always** re-resolve before high-consequence actions (purchases, bookings, or any action with real-world side effects).

The critical property: **every single HTTP request is authenticated**. There are no sessions to hijack, no tokens to steal. If the key is compromised, revoke it on-chain and all future requests from the old key are rejected.

---

## 4. Connection Flow

Two connection models are supported. **Invitation Link is the default** — it's how most people will connect their agents in practice.

### 4.1 Invitation Link (Default Flow)

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
 │            │      from: { agentId: 77, ... },            │            │
 │            │      to: { agentId: 42, ... },              │            │
 │            │      nonce: "abc123",                       │            │
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

**Note on `trustedagents.link`**: This is a data-carrying URI convention, not a required live service. The receiving agent parses the query parameters (`agentId`, `chain`, `nonce`, `expires`, `sig`) directly from the URL — no web server at `trustedagents.link` needs to be running. The domain simply provides a human-recognizable namespace.

**Invite redemption rule**: The inviter stores each generated invite nonce in a local `pendingInvites` store with status (`unused`, `redeemed`, `expired`). A bootstrap `connection/request` referencing an invite nonce is accepted only if the nonce exists, is unexpired, and is still `unused`; once accepted, it is atomically marked `redeemed`.

### 4.2 Direct Connection Request

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
  "jsonrpc": "2.0",
  "method": "connection/request",
  "id": "req-uuid-001",
  "params": {
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
- Scope is **extensible** — new capability types can be added without protocol changes.
- Unknown runtime scopes are **rejected by default** (`403 Forbidden`) unless explicitly configured in local permissions.
- Scope is **enforced locally** — each agent checks incoming requests against the stored scope for that peer before processing.

**Enforcement model**: Scope defines what the *owner* permits their agent to do with a given peer, and enforcement happens locally on both sides. When Alice's agent receives a message from Bob's agent tagged with `scope: "purchases"`, it checks whether Alice has granted Bob purchasing permissions — if not, the request is rejected. Conversely, Alice's agent will not *send* a request under a scope that Alice hasn't approved. There is no honor system: both agents independently enforce their own owner's permissions.

> **Terminology note**: Three related terms appear throughout this spec:
> - **Capabilities** — what an agent *can do*, declared in its registration file (array of strings, e.g. `["scheduling", "research"]`).
> - **Permissions** — what an owner *permits* for a given peer, stored in the trust store (object mapping scope labels to configuration).
> - **Scope** — which permission a specific message operates under (single string in message metadata, e.g. `"scheduling"`).

### 4.4 Trust Store (Local State)

Each agent maintains a local trust store — the contacts list. Stored as a JSON file (consistent with OpenClaw's file-based architecture).

**connectionId format**: connectionIds are UUIDv4 values generated by the initiating agent at connection establishment time. They are unique per trust relationship.

```json
// ~/.trustedagents/contacts.json
{
  "contacts": [
    {
      "connectionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "peerAgentId": 77,
      "peerChain": "eip155:8453",
      "peerOwnerAddress": "0xBob...",
      "peerDisplayName": "Bob's Agent",
      "peerEndpoint": "https://bob-agent.example.com/a2a",
      "peerAgentAddress": "0x...",
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

We might introduce a shared trust store in the future. If it doesn't add too much complexity we should add an abstraction to make this possible.

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

**Critical security rule**: All non-bootstrap methods MUST be signed by a key in the trust store; otherwise return `403 Forbidden` with no additional information. Bootstrap methods (`connection/request`, `connection/accept`, `connection/reject`) may be processed pre-trust only when they match a valid handshake context (invite nonce or pending local connection flow), pass signature verification, and satisfy expiry checks. The endpoint should not leak data to unauthenticated callers.

### 5.3 Message Format

Messages use the A2A protocol format with Trusted Agent metadata extensions:

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "id": "msg-uuid-001",
  "params": {
    "message": {
      "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "Alice wants to schedule dinner Thursday. What times work?"
        }
      ],
      "metadata": {
        "trustedAgent": {
          "connectionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          "conversationId": "conv-dinner-2026-03-02",
          "scope": "scheduling",
          "requiresHumanApproval": false
        }
      }
    }
  }
}
```

> **A2A version note**: This spec targets A2A `v0.3.0` and uses its method and message shapes (`message/send`, `Message.messageId`). For MVP, interoperability is required between Trusted Agents implementations; optional A2A fields outside this profile may be ignored.

> **On extensions**: A2A defines an extensions mechanism for protocol-level extensions. The `trustedAgent` fields in `metadata` use free-form metadata rather than a registered extension, which is simpler for v1. A formal A2A extension URI (e.g., `urn:trustedagents:v1`) may be registered in a future version.

**Extension fields**:

| Field | Purpose |
|---|---|
| `connectionId` | References the established trust relationship. Both agents know the permissions. |
| `conversationId` | Groups related messages into a conversation thread for logging and human review. |
| `scope` | Declares which permission scope this message operates under. Receiver validates against stored permissions. |
| `requiresHumanApproval` | Hints that this message involves a decision the receiving agent should escalate to its human. |

> **Note on `messageId`**: The `messageId` field shown in the message example above is part of the A2A base spec (`Message.messageId`), not a Trusted Agent extension. It is required by A2A for message deduplication and reference.

### 5.4 Request Types

The protocol defines these request types, all sent as A2A messages:

| Request | Description | Requires Human Approval? | Allowed Pre-Trust? |
|---|---|---|---|
| `connection/request` | Initial connection request | Always | Yes (must match valid handshake context) |
| `connection/accept` | Accept a connection | Always | Yes (must match pending request/nonce) |
| `connection/reject` | Reject a connection | Always | Yes (must match pending request/nonce) |
| `connection/revoke` | Revoke an existing connection | Always | No |
| `connection/update-scope` | Modify permissions on a connection | Always | No |
| `message/send` | Send a conversational message | Per agent configuration | No |
| `message/action-request` | Request the peer agent to take an action | Configurable per scope | No |
| `message/action-response` | Response to an action request | No (response to approved request) | No |

---

## 6. Conversation Logging

All agent-to-agent conversations MUST be logged in a structured, human-readable format. This is a core requirement — humans must be able to review what their agent says and does on their behalf.

### 6.1 Conversation Log Format

Each conversation is stored as a structured log file:

```json
// ~/.trustedagents/conversations/conv-dinner-2026-03-02.json
{
  "conversationId": "conv-dinner-2026-03-02",
  "connectionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
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
│  ┌────────────────────┐                                          │
│  │  ERC-8004           │                                          │
│  │  Identity Registry  │                                          │
│  │                     │                                          │
│  │  agentId (ERC-721)  │                                          │
│  │  → tokenURI         │                                          │
│  │  → owner wallet     │                                          │
│  └────────────────────┘                                          │
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
│      { "name": "A2A", "endpoint": "https://alice.agent/a2a" }   │
│    ],                                                            │
│    "trustedAgentProtocol": {                                     │
│      "version": "1.0",                                           │
│      "agentAddress": "0xAgentPublicAddress...",                   │
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

### 7.1 Error Handling and Failure Modes

| Failure | Detection | Response |
|---|---|---|
| **Replayed nonce** | Nonce already consumed in local nonce store | Reject with `400 Bad Request`. Log the attempt. |
| **Offline agent** | Connection timeout or DNS failure | Queue message for retry with exponential backoff (max 3 retries). Notify owner if peer remains unreachable after all retries. |
| **Key rotation** | On-chain re-resolve returns a different `agentAddress` than stored | Update trust store with new address. Re-verify the current request against the new key. If verification fails, reject and notify owner. |
| **Unknown scope** | Incoming message references a scope not in the stored permissions | Reject with `403 Forbidden`. Do not leak which scopes are valid. |
| **Signature failure** | ERC-8128 signature does not verify against known `agentAddress` | Reject with `403 Forbidden`. Log the attempt with details for the owner. |
| **Expired invite** | `expires` timestamp is in the past | Reject invite processing. Inform user the invite has expired and a new one is needed. |
| **Deactivated identity** | On-chain re-resolve shows NFT burned or transferred | Remove peer from trust store. Notify owner that the connection is no longer valid. |
| **Content-Digest mismatch** | Body hash doesn't match `Content-Digest` header | Reject with `400 Bad Request`. Possible tampering or corruption in transit. |

### 7.2 Versioning

The Trusted Agents Protocol uses semantic versioning. Version negotiation rules:

- **Same major version required**: Agents with different major versions (e.g., v1 and v2) cannot communicate. The initiating agent should include its protocol version in the connection request.
- **Minor version tolerance**: An agent running v1.2 can communicate with an agent running v1.0. The higher-versioned agent must not use features from the newer minor version unless the peer has acknowledged support.
- The `trustedAgentProtocol.version` field in the registration file declares the agent's supported protocol version.

### 7.3 Connection Lifecycle

Connections do not expire automatically but can be explicitly revoked by either party via `connection/revoke`.

**Staleness recommendations**:

| Status | Condition | Recommended Action |
|---|---|---|
| **Active** | Last contact within 24 hours | No action needed. |
| **Idle** | Last contact between 24 hours and 7 days | Re-resolve on-chain before next communication. |
| **Stale** | Last contact more than 30 days ago | Re-resolve on-chain. Optionally notify owner to confirm connection is still desired. |

Agents should update `lastContactAt` in the trust store on every successful message exchange.

### 7.4 Security Considerations

- **Per-peer rate limiting**: Each agent should enforce rate limits per trusted peer to prevent abuse from a compromised peer agent. Recommended: configurable limit (e.g., 60 requests/minute per peer).
- **Trust store integrity**: The trust store file (`contacts.json`) should be protected with filesystem permissions (owner-only read/write). Corruption or tampering with the trust store could allow unauthorized communication.
- **Key storage**: The agent's private key must be stored securely — environment variable, encrypted keyfile, or hardware security module. It must never be committed to version control, logged, or transmitted.
- **Registration file integrity**: While hosted over HTTPS, the registration file is not signed. Agents should verify that the `agentAddress` in the registration file matches the key used in ERC-8128 signatures. A mismatch indicates a compromised registration file or DNS hijack.

---

## 8. End-to-End Walkthrough

### Phase 0: Setup (one-time per agent)

```
1. Generate or assign a private key for the agent.

2. From the owner's wallet(or the agent's wallet if the user asks the agent to do it), mint an ERC-8004 identity NFT.
   → This gives the agent an agentId (e.g., 42).
   → The owner wallet is the NFT owner.

3. Create a registration file:
   {
     "type": "eip-8004-registration-v1",
     "name": "Alice's Personal Agent",
     "description": "Personal assistant for scheduling, research, comms",
     "services": [
       { "name": "A2A", "endpoint": "https://alice-agent.example.com/a2a" }
     ],
     "trustedAgentProtocol": {
       "version": "1.0",
       "agentAddress": "0xAgentPublicAddress...",
       "capabilities": ["scheduling", "research", "general-chat"]
     }
   }

4. Upload it to IPFS
   Set tokenURI via setAgentURI(agentId, https://...).

5. Configure the agent runtime with:
   - The private key
   - The trusted-agents skill
   - Notification preferences (which messaging channel, approval rules)

6. Start the agent server (HTTPS endpoint accessible).
```

### Phase 1: Alice Invites Bob

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
- [ ] Create and host registration files (HTTPS) with Trusted Agent protocol extensions
- [ ] Implement ERC-8128 HTTP request signing directly with ethers.js/viem + RFC 9421
- [ ] Implement ERC-8128 signature verification middleware
- [ ] Build registration file resolver (agentId → on-chain lookup → fetch registration file)
- [ ] **Tests**: Unit tests for ERC-8128 sign/verify round-trip, Content-Digest computation, nonce generation

### Milestone 2: Connection Flow

- [ ] Implement invitation link generation (sign, encode, return URL)
- [ ] Implement invite verification and on-chain resolution
- [ ] Build connection request / acceptance handshake
- [ ] Implement local trust store (contacts.json read/write)
- [ ] Human notification for connection approvals (via agent's messaging channel)
- [ ] **Tests**: Integration test with two agents completing a full invite → accept → store flow

### Milestone 3: Communication

- [ ] A2A server endpoint with ERC-8128 auth guard (reject if not in trust store)
- [ ] Transport interface abstraction (even though v1 only has HTTP)
- [ ] Message routing: incoming message → check trust → check scope → process
- [ ] Conversation logging (structured JSON + markdown transcript generation)
- [ ] Human notification for messages requiring approval
- [ ] Permission engine (validate message scope against stored permissions)
- [ ] **Tests**: Integration test for message exchange, permission denial, and conversation logging. Adversarial tests: replayed nonce, forged signature, unknown scope.

### Milestone 4: OpenClaw Integration

- [ ] Package as an OpenClaw skill
- [ ] Commands: `/connect <invite-link>`, `/invite`, `/contacts`, `/conversations`
- [ ] Conversation review via chat: `/conversations with Bob`
- [ ] Notification preferences configuration
- [ ] Agent-to-agent message sending from natural language instructions
- [ ] **Tests**: End-to-end test of OpenClaw skill commands with mock agents

### Code vs. Skills Boundary

The implementation is split between a reusable library and OpenClaw-specific skills:

**npm library** (`trusted-agents-core`):
- ERC-8128 request signing and verification (ethers.js/viem + RFC 9421)
- Registration file resolver (on-chain lookup → fetch → parse)
- Trust store management (CRUD operations on contacts.json)
- Transport interface (abstract + DirectHttpTransport implementation)
- Permission engine (scope validation, rate limiting)

**OpenClaw skills** (consume the library):
- Connection manager skill (invite generation, handshake orchestration)
- Conversation logger skill (structured JSON + markdown transcript)
- Human notification skill (approval flows, real-time alerts)
- User commands: `/connect`, `/invite`, `/contacts`, `/conversations`

---

## 10. Design Decisions and Future Extensions

### Decisions Made for v1

| Decision | Rationale |
|---|---|
| Dedicated agent key (not owner wallet key) | Security isolation. If the agent key is compromised, the owner's wallet is unaffected. Key rotation doesn't require NFT transfer. |
| Direct ERC-8128 implementation (ethers.js/viem + RFC 9421) | No dependency on external auth SDKs. ERC-8128 handles both identity proof and request signing — a separate handshake protocol is unnecessary. |
| One agent per person | Simplicity. The ERC-8004 model (one wallet, multiple agentIds) supports multi-agent later. |
| Agents run on servers (always on) | Simplicity. Relay/mailbox for offline agents is a future transport. |
| Endpoints and registration files are public | Simplicity. Conversations are private. Endpoint privacy can be layered on later. |
| ERC-8128 for all HTTP signing | It's the purpose-built standard. Built on RFC 9421, composable with ERC-8004. |
| Trust scope is extensible per-peer | Users need granular control. Start with a few standard scopes, allow custom ones. |
| HTTPS for registration file hosting (v1) | Simpler deployment than IPFS. IPFS is a future option for immutability. |

### Planned Future Extensions

| Extension | Description |
|---|---|
| **Session key delegation** | Owner signs a scoped, time-limited delegation to an ephemeral key. Agent holds only the ephemeral key. Limits blast radius of compromise. |
| **Encrypted relay transport** | Mailbox service for when agents are offline. Messages encrypted end-to-end, relay is a dumb pipe. |
| **P2P transport** | Direct peer-to-peer connections via libp2p or similar. No server needed. |
| **Multi-agent per human** | Separate work and personal agents, each with their own identity and trust relationships. |
| **Private endpoints** | Endpoints shared only with trusted contacts (not in the public registration file). |
| **Reputation Registry integration** | Record trust relationships on-chain via the ERC-8004 Reputation Registry for public verifiability. Not used in v1 flows. |
| **MCP tool integration** | Expose agent tools and resources via MCP alongside A2A communication. Complementary to A2A — MCP for tools, A2A for agent-to-agent collaboration. |
| **SIWA (Sign In With Agent)** | Agent-to-server authentication protocol built on ERC-8004 + ERC-8128. Useful if agents need to authenticate with third-party web services, but not required for agent-to-agent trust. See `siwa.builders.garden`. |
| **A2A extension URI** | Register a formal A2A extension URI (e.g., `urn:trustedagents:v1`) instead of using free-form metadata for `trustedAgent` fields. |
| **Phone/email identity verification** | Additional ownership proof methods beyond wallet signatures. |
| **Group connections** | Trust relationships involving multiple agents (e.g., a project team). |
| **Audit dashboard** | Web interface for reviewing all agent conversations, filtering by contact and topic. |
| **IPFS registration files** | Host registration files on IPFS for immutability guarantees and censorship resistance. |

---

## Appendix A: Key References

### Core Dependencies

- **ERC-8004 Spec**: https://eips.ethereum.org/EIPS/eip-8004
- **ERC-8004 Contracts**: https://github.com/erc-8004/erc-8004-contracts
- **ERC-8128 Discussion**: https://ethereum-magicians.org/t/erc-8128-signed-http-requests-with-ethereum/27515
- **A2A Protocol (latest spec)**: https://a2a-protocol.org/latest/specification/
- **A2A Protocol (v0.3.0 release spec)**: https://a2a-protocol.org/v0.3.0/specification/ — pinned for v1 MVP implementation.
- **A2A GitHub**: https://github.com/a2aproject/A2A
- **RFC 9421 (HTTP Message Signatures)**: https://www.rfc-editor.org/rfc/rfc9421

### Related Projects (not core dependencies)

- **SIWA (Sign In With Agent)**: https://siwa.builders.garden — agent-to-server authentication protocol built on ERC-8004 + ERC-8128. Solves a different problem (agent authenticating with web services) than Trusted Agents (agent-to-agent trust).
- **OpenClaw**: https://openclaw.ai — agent runtime framework

## Appendix B: Deployed Registry Addresses

### Identity Registry (used in v1)

| Network | Address |
|---|---|
| Base Mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Ethereum Mainnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

> **Note**: For development and testing, deploy to Base Sepolia. The ERC-8004 contracts use CREATE2 deterministic deployment — the same deployer + salt yields the same address across networks.

### Reputation Registry (not used in v1 — future extension)

| Network | Address |
|---|---|
| Base Mainnet | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Ethereum Mainnet | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

> These addresses are deployed but the Reputation Registry is not used in any v1 protocol flow. See "Reputation Registry integration" in the Future Extensions table.
