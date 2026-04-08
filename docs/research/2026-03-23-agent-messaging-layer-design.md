# Agent Messaging Layer Research And Tentative Design

Date: 2026-03-23

Status: draft

## Goal

Design a TAP-adjacent messaging layer for agents that is:

- encrypted
- simple to integrate
- cheap
- private
- reliable
- resistant to spam via paid sending
- usable with wallets and non-wallet signature types
- not dependent on permanent network storage

This document combines:

1. what TAP already does well
2. external protocol research
3. a tentative high-level design
4. open questions that still need product decisions

## Product Decisions Captured On 2026-03-23

The current working assumptions are:

- start with a **shared public network**
- make the network as **permissionless** as practical
- allow **private isolated relay sets** later for enterprise use
- support **group channels** in v1
- accept **stablecoins only** for paid sending
- target roughly **30 days of relay-backed retention**
- keep **local encrypted history on by default**, with configurable retention and an easy off switch
- use **global message credits** across the shared network
- target a **v1 default maximum group size of 256 members**

## Executive Summary

The best design is probably **not** "an appchain where every message is a transaction".

The simpler and stronger design is:

- **JSON-RPC agent messages** as the application protocol
- **end-to-end encryption** on clients
- **shared permissionless relay domains** instead of appchain-first routing
- **isolated private relay sets** for enterprise use, using the same protocol
- **30-day relay-backed storage** instead of permanent storage
- **root identities** based on wallets or passkeys
- **delegated session keys** for the actual agent runtime
- **MLS-backed group channels** for multi-agent conversations
- **stablecoin-funded message credits** or postage tickets to stop spam
- **multi-chain payment verification** at the edge, not in the hot messaging path

In other words: build a **secure relay network with a trust/payment layer**, not a consumer chat protocol and not a blockchain-first system.

## What TAP Already Gets Right

TAP already has several good primitives worth preserving:

- **Invite-based trust bootstrap**. TAP does not assume a global directory. Connections are bootstrapped with a signed invite: [packages/core/src/connection/invite.ts](../../packages/core/src/connection/invite.ts).
- **Structured agent messages**. TAP already uses JSON-RPC 2.0 style methods such as `connection/request`, `message/send`, `action/request`, and `action/result`: [packages/core/src/protocol/methods.ts](../../packages/core/src/protocol/methods.ts).
- **A transport seam**. Core already models transport as a replaceable interface instead of baking XMTP into every call path: [packages/core/src/transport/interface.ts](../../packages/core/src/transport/interface.ts).
- **Directional permissions**. TAP distinguishes "connected" from "authorized" and keeps grants separate from transport.
- **Local-first runtime**. Trust state, request journals, and message logs live locally rather than in a TAP backend.

These are all compatible with a new messaging substrate.

## Where TAP Is Too Constrained Today

Current TAP messaging is tied to several assumptions that are probably too narrow for a general agent-native messaging layer:

- **XMTP-specific transport**: TAP currently uses XMTP as the only transport: [packages/core/src/transport/xmtp.ts](../../packages/core/src/transport/xmtp.ts).
- **EVM-only transport signer**: the XMTP signer is currently created from a raw EVM private key and exposes `type: "EOA"`: [packages/core/src/transport/xmtp-signer.ts](../../packages/core/src/transport/xmtp-signer.ts).
- **Identity coupling**: TAP today largely assumes one private key is the trust root, invite signer, and transport identity.
- **Durable message logs**: TAP currently persists conversation logs to disk and XMTP stores a local encrypted DB.

For the new design, those should become optional host choices rather than protocol assumptions.

## Research Findings

### 1. Tempo has the right identity shape for agents

The most important Tempo pattern is not "wallet auth" by itself. It is **wallet root identity plus delegated runtime key**.

Local Tempo CLI inspection on this machine shows:

- a top-level `wallet`
- a separate delegated `key`
- `chain_id`
- `network`
- `spending_limit`
- `remaining`
- `expires_at`

That is a strong pattern for agents:

- humans or operators authenticate/control a root wallet or passkey
- the agent runtime uses a delegated session key
- the delegated key has scope, spending limits, and expiration

This is much better than forcing the hot path of every message to use the owner's root wallet key.

### 2. A2A has the right application-layer shape

The A2A protocol uses:

- JSON-RPC 2.0
- capability discovery via agent cards
- sync request/response
- streaming and async push

That lines up well with TAP's current message shape and with agent workflows more broadly. It suggests the messaging layer should stay **structured and RPC-friendly**, not become a chat-only wire format.

Source: [A2A README](https://github.com/a2aproject/A2A)

### 3. XMTP shows the right split between data plane and control plane

XMTP's decentralized design separates:

- fast message handling
- ordered identity/group metadata

That is the right mental model: not everything in a secure messaging system needs consensus or chain settlement.

Source: [XMTP decentralization](https://xmtp.org/decentralization), [XIP-49](https://improve.xmtp.org/t/xip-49-decentralized-backend-for-mls-messages/856)

### 4. Waku is a useful reference for ephemeral relays and anti-spam

Waku is relevant for three reasons:

- it is built around relays instead of centralized inbox servers
- storage is modular rather than mandatory
- it treats spam resistance as a first-class network problem

The most relevant ideas are:

- **Relay / LightPush / Filter / Store** as separate protocols
- **RLN** for privacy-preserving rate limits
- optional historical storage instead of mandatory permanent retention

Even if TAP does not adopt Waku directly, the modular split is a good design reference.

Sources:

- [Waku protocols overview](https://docs.waku.org/learn/concepts/protocols/)
- [Waku network overview](https://docs.waku.org/learn/)
- [Waku research on RLN and economic spam resistance](https://docs.waku.org/research/)

### 5. x402 and SIWX are the best reference for multi-chain payment-aware auth

x402 is valuable here because it cleanly separates:

- authentication
- payment negotiation
- settlement verification

The most relevant parts:

- wallet as both identity and payment mechanism
- chain-agnostic network identifiers
- support for both EVM and Solana
- smart wallet verification support (`EIP-1271`, `EIP-6492`)
- payment/auth challenges that can be verified server-side

This suggests the messaging network should not "read arbitrary chains" on every send. Instead it should:

- accept standardized payment proofs or payment-issued credits
- verify them through per-chain adapters
- then spend internal message credits in the hot path

Sources:

- [x402 wallet concept](https://docs.x402.org/core-concepts/wallet)
- [x402 SIWX](https://docs.x402.org/extensions/sign-in-with-x)
- [EIP-4361 / SIWE](https://eips.ethereum.org/EIPS/eip-4361)

### 6. WebAuthn is the best non-wallet root identity to support

If non-wallet signatures matter, passkeys are the obvious second root identity.

Why:

- strong public key credentials
- widely supported
- good UX
- scoped credentials and strong challenge-response semantics

Source: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)

## Requirements, Interpreted Strictly

### Encrypted

Messages should be encrypted end to end. Relay operators should not read content.

### No permanent storage

The network should provide **TTL-based store-and-forward**, not indefinite retention.

Interpretation:

- relay storage is temporary, but "temporary" can still mean about a month
- clients may keep local logs if they want
- the protocol should not assume a permanent history service

### Wallets and other signature types

The protocol should support at least:

- EVM EOAs
- EVM smart wallets
- Solana wallets
- WebAuthn / passkeys
- delegated session keys for autonomous runtimes

### Multi-chain payments

The system should understand payment from more than one chain, but **not** by forcing relay nodes to perform arbitrary chain introspection on every message.

### Simple and reliable

This means:

- one clean SDK surface
- at-least-once delivery
- idempotency keys
- delivery receipts
- retry-safe semantics
- clear failure states

It does **not** mean exactly-once delivery. That is usually the wrong target for agent messaging.

## Design Principles

1. **Keep the hot path off-chain**
   Message send, relay accept, and recipient delivery should not require chain reads.

2. **Separate root identity from runtime identity**
   Wallets and passkeys should authorize agent session keys; they should not necessarily sign every message.

3. **Pay once, spend many**
   Convert chain payments into short-lived message credits or postage tickets.

4. **Support structured agent RPC first**
   Preserve TAP-style/A2A-style structured messages over plain chat semantics.

5. **Assume relays are untrusted for content, trusted for availability**
   Encrypt end to end; use signatures for sender authenticity; treat relays as delivery infrastructure.

6. **Design for a shared public network first**
   Private subnets should be the same protocol with different routing and admission policies, not a separate stack.

## Tentative High-Level Design

### 1. Identity Model

Use a two-layer identity model.

#### Root identity

A root identity can be one of:

- `did:pkh` for chain accounts
- `did:key` for non-chain keys
- a WebAuthn-backed identity

Supported root signer types in v1:

- EVM EOA
- EVM smart wallet (`EIP-1271`, optionally `EIP-6492`)
- Solana wallet
- WebAuthn passkey

#### Session identity

Each running agent uses a delegated session key:

- generated locally by the agent runtime
- signed/authorized by the root identity
- short-lived
- revocable
- optionally scoped
- optionally spend-limited

This is the most important design choice.

It gives:

- safer hot-path operations
- support for autonomous agents
- easier multi-device or multi-runtime deployments
- Tempo-like spending controls

#### Delegation object

The root identity signs a delegation document roughly like:

```json
{
  "version": "agent-session/v1",
  "root": "did:pkh:eip155:8453:0x...",
  "sessionKey": "did:key:z6Mk...",
  "issuedAt": "2026-03-23T00:00:00Z",
  "expiresAt": "2026-03-30T00:00:00Z",
  "capabilities": ["message/send", "action/request"],
  "spending": {
    "currency": "message-credits",
    "max": "5000"
  }
}
```

Messages are signed by the session key. The envelope carries the delegation chain needed for verification.

### 2. Transport Model

Use **encrypted relays with shared public routing, optional isolated private relay sets, and 30-day store relays**.

Core behavior:

- sender submits encrypted message to one or more relays
- relay validates sender identity and message credit
- relay or store peer stores the envelope for a bounded TTL
- recipient pulls or streams from relays
- recipient returns an application ack

Recommended network roles:

- **relay peers** for gossip / fanout / online delivery
- **store peers** for 30-day retrieval
- **verifier peers** for payment-credit issuance and proof verification

This split keeps the network simpler:

- not every peer has to be a month-long storage node
- public relays stay cheap enough to run
- operators can specialize by role

Recommended v1 transport:

- WebSocket for streaming
- HTTPS for send/poll fallback
- QUIC later if needed

Recommended storage semantics:

- shared network TTL target: 30 days
- no permanent relay history
- encrypted local history on by default
- configurable local retention and explicit pruning

#### Shared network and private relay sets

The cleanest way to support both public and enterprise use is to separate:

- **protocol semantics** from
- **routing domain** from
- **relay admission policy**

Suggested model:

- one shared public domain for the common network
- additional fully isolated relay sets for enterprise/private use
- public routing can still use shard-like routing identifiers within the shared network

This is close to the Waku idea of a shared network with sharded routing, but it keeps private deployments operationally separate when that matters.

### 3. Encryption Model

Use two modes.

#### Pairwise messages

Default for most agent workflows.

Use:

- X25519 or HPKE-based key agreement
- symmetric payload encryption such as ChaCha20-Poly1305 or AES-GCM

#### Group messages

Groups are required in v1.

Use:

- MLS for group membership and rekeying
- explicit channel epochs so membership and message decryption stay consistent

Rationale:

- group channels are now a product requirement
- MLS is the most credible standard way to get secure asynchronous group messaging with forward secrecy and post-compromise security
- pairwise fanout is simpler, but it will become the wrong primitive once channels are a first-class concept
- a **256-member default limit** is a reasonable v1 cap: large enough for real multi-agent channels, small enough to keep membership churn, key updates, and operational complexity under control

Source: [RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420), [RFC 9750](https://datatracker.ietf.org/doc/html/rfc9750)

### 4. Message Envelope

Keep the application envelope close to current TAP and A2A shapes.

Suggested outer envelope:

```json
{
  "version": "agent-msg/v1",
  "messageId": "uuid",
  "conversationId": "uuid",
  "networkDomain": "shared",
  "channelId": "channel-uuid",
  "channelEpoch": 42,
  "sender": {
    "session": "did:key:z6Mk...",
    "root": "did:pkh:eip155:8453:0x..."
  },
  "recipient": {
    "inbox": "opaque-inbox-id"
  },
  "createdAt": "2026-03-23T00:00:00Z",
  "expiresAt": "2026-04-22T00:00:00Z",
  "idempotencyKey": "uuid",
  "postage": {
    "type": "credit",
    "proof": "..."
  },
  "ciphertext": "base64..."
}
```

`expiresAt` is a per-message retention bound and should be less than or equal to the network/domain maximum.

Suggested inner plaintext payload:

- JSON-RPC 2.0 request/result
- typed TAP actions
- capability negotiation
- receipts and errors

This preserves compatibility with TAP's current mental model.

### 5. Payment And Anti-Spam Model

Do **not** make relays inspect arbitrary payment transactions on every send.

Instead use a two-step model.

#### Step A: payment to credit conversion

The sender (or owner) pays on a supported chain.

A verifier/facilitator service:

- watches that chain
- verifies payment finality
- mints message credits or a signed postage token

#### Step B: hot-path spend

Each outbound message includes:

- a signed postage token, or
- a relay-issued spend authorization, or
- a decrement against a pre-funded credit balance

Relays only need to verify the proof and decrement balance. No chain RPC is needed in the hot path.

#### Why this is the right model

It gives:

- multi-chain funding
- cheap message acceptance
- clear spam economics
- simpler relay implementation

For the shared public network, this also allows:

- a published pricing schedule in stablecoin units
- predictable economics across relay operators
- globally fungible credits across the shared network

For private isolated relay sets, operators can still choose to:

- honor the same global credits
- require their own pricing
- subsidize traffic internally

Those are deployment policies, not protocol changes.

#### What chains to support first

Based on the current TAP/Tempo context and the stablecoin-only decision, a reasonable first set is:

- Base
- Taiko
- Solana

Use CAIP-2 network identifiers internally and a chain adapter boundary for verification.

Stablecoin guidance:

- support a small allowlist first
- start with USDC where available
- add other stablecoins only when there is a real routing or settlement reason

### 6. Reliability Model

Aim for **at-least-once** delivery.

Recommended mechanics:

- sender gets relay accept receipt
- recipient emits application ack
- sender retries until ack or expiry
- recipients dedupe by `messageId` or `idempotencyKey`
- store peers replicate each accepted envelope to at least 2 or 3 storage peers

This is the right tradeoff for agents:

- simple enough to implement
- reliable enough for task coordination
- compatible with action/request/result flows

### 7. Discovery And Addressing

Keep discovery minimal.

TAP's invite model should remain valid:

- share signed invite out of band
- establish trust
- exchange current inbox endpoints and supported signers

Optional later:

- public agent card
- transport endpoints
- supported payment networks
- preferred relay set
- private relay-set preferences

## Why Not Start With A Dedicated Appchain

An appchain may become useful later, but it is probably the wrong v1.

Reasons:

- the network does not need permanent storage
- the send path should stay cheap and low-latency
- spam is better handled with prepaid credits than per-message settlement
- identity delegation and relay reliability matter more than consensus at the start
- public-network sharding and MLS channels already provide enough structure for v1

An appchain becomes more attractive only if we later need:

- third-party relay federation with shared billing
- globally auditable credit balances
- dispute resolution between operators
- chain-native slashing or staking
- public reward distribution to relay/store operators

Until then, a relay network plus signed credits is the simpler design.

## Suggested v1 Scope

### Must have

- pairwise encrypted messaging
- MLS group channels
- v1 default group size cap of 256
- root identity plus delegated session key
- EVM + WebAuthn signer support
- multi-chain funding through a payment verifier boundary
- stablecoin-only prepaid message credits
- shared public network domain
- optional private isolated relay sets using the same protocol
- relay and store peer split
- 30-day relay-backed storage
- JSON-RPC request/result semantics
- delivery ack + retry
- encrypted local history on by default

### Should wait until v2

- chain-enforced relay incentives
- on-chain settlement of credits
- metadata privacy hardening beyond the basic model
- attachments and large object transport

## Biggest Risks

1. **Metadata privacy**
   Even with encrypted content, relays can still learn timing and routing metadata.

2. **Delegation complexity**
   Session key delegation needs a clean, auditable format or it will become brittle.

3. **Cross-chain payment verification**
   The protocol should standardize interfaces here, but each supported chain still adds operational work.

4. **Spam economics**
   Underpricing messages will get the network abused. Overpricing will kill adoption.

5. **SDK ergonomics**
   If integration is not much easier than XMTP, the product loses one of its main reasons to exist.

## Tentative Recommendation

If the goal is an agent-native layer for TAP-like communication, the best first design is:

- **structured JSON-RPC agent envelopes**
- **end-to-end encrypted pairwise and MLS group messaging**
- **shared public relay routing with optional isolated private relay sets**
- **30-day relay-backed storage instead of permanent history**
- **root signer + delegated agent session key**
- **stablecoin-funded multi-chain prepaid credits with global shared-network fungibility**
- **out-of-band invite bootstrap**

This is both simpler and more aligned with your goals than:

- direct blockchain messaging
- permanent network storage
- forcing every agent to be wallet-native in the hot path

## Open Questions

These decisions will materially change the design:

1. Do we want the default sender identity to be:
   - wallet first
   - passkey first
   - session key first with wallet/passkey attestation
2. Should group membership be visible to relay operators as metadata, or should we try to hide group roster information from the transport layer as much as possible?
3. Should private relay sets be able to enforce stricter local admission and pricing policies while still honoring the shared public identity format?

## References

- TAP transport interface: [packages/core/src/transport/interface.ts](../../packages/core/src/transport/interface.ts)
- TAP protocol methods: [packages/core/src/protocol/methods.ts](../../packages/core/src/protocol/methods.ts)
- TAP XMTP transport: [packages/core/src/transport/xmtp.ts](../../packages/core/src/transport/xmtp.ts)
- TAP XMTP signer: [packages/core/src/transport/xmtp-signer.ts](../../packages/core/src/transport/xmtp-signer.ts)
- TAP invites: [packages/core/src/connection/invite.ts](../../packages/core/src/connection/invite.ts)
- A2A: https://github.com/a2aproject/A2A
- XMTP decentralization: https://xmtp.org/decentralization
- XIP-49: https://improve.xmtp.org/t/xip-49-decentralized-backend-for-mls-messages/856
- Waku docs: https://docs.waku.org/
- RFC 9420: https://datatracker.ietf.org/doc/html/rfc9420
- RFC 9750: https://datatracker.ietf.org/doc/html/rfc9750
- x402 wallet: https://docs.x402.org/core-concepts/wallet
- x402 SIWX: https://docs.x402.org/extensions/sign-in-with-x
- EIP-4361: https://eips.ethereum.org/EIPS/eip-4361
- WebAuthn Level 3: https://www.w3.org/TR/webauthn-3/
