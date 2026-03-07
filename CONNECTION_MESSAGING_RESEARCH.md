# Connection And Messaging Research

Date: 2026-03-06

## Executive Summary

TAP's current connection and messaging model assumes that each agent has a live XMTP receive loop running when it needs to accept new connections, receive messages, or return JSON-RPC responses. That assumption is workable for production agents if they run as supervised long-lived services with persistent local storage. It is not a strong fit for ad hoc CLI usage where a human or agent starts `tap message listen` in a terminal and leaves it running.

My recommendation is:

1. Keep XMTP for the current product direction if the goal is wallet-native, cross-operator, agent-to-agent messaging.
2. Stop treating `tap message listen` as the production operating model.
3. Introduce a resident daemon or SDK host process per identity, plus a local control plane for sends and approvals.
4. Use XMTP streaming as the primary receive path, and use `syncAll` as reconciliation on startup and after failures.
5. Do not rely on heartbeat-only polling with the current synchronous request/response protocol. It will cause timeouts and recovery gaps unless the protocol becomes asynchronous.
6. If the primary goal shifts toward reliable internal automation rather than open agent interoperability, consider a second transport such as NATS JetStream behind the existing `TransportProvider` seam.

## 1. Current TAP Flow

### 1.1 Transport model

`packages/core/src/transport/interface.ts` defines a swappable `TransportProvider` with:

- `send(peerId, message, options?)`
- `onMessage(handler)`
- `isReachable(peerId)`
- optional `start()` / `stop()`

In practice, the only transport implementation today is `XmtpTransport` in `packages/core/src/transport/xmtp.ts`.

### 1.2 Connection bootstrap today

Current connection bootstrap is invite-based and synchronous:

1. `tap invite create` signs an invite URL and stores the nonce in `pending-invites.json`.
2. `tap connect <invite>` resolves the peer on-chain, verifies the invite signature, starts XMTP, sends `connection/request`, waits for a JSON-RPC response, then persists the contact.
3. The receiver must already be running a listener so that XMTP can deliver the inbound `connection/request`.
4. The receiver's listener resolves the sender again, prompts or auto-approves, stores the contact as `active`, and returns a JSON-RPC response containing a `connectionId`.

Relevant code:

- `packages/cli/src/commands/invite-create.ts`
- `packages/cli/src/commands/connect.ts`
- `packages/core/src/connection/request-handler.ts`
- `packages/core/src/transport/xmtp.ts`
- `packages/core/src/protocol/methods.ts`

### 1.3 Message send today

`tap message send` is also synchronous:

1. Load config and trust state.
2. Start XMTP.
3. Send `message/send`.
4. Wait for a JSON-RPC response.
5. Append the outgoing conversation log.
6. Stop XMTP.

Relevant code:

- `packages/cli/src/commands/message-send.ts`
- `packages/cli/src/lib/message-conversations.ts`

### 1.4 What must happen for an agent to listen actively

For inbound connections or messages to be handled in TAP today, all of the following must be true:

1. A process must register a handler with `transport.onMessage(...)`.
2. That same process must call `transport.start()`.
3. The process must stay alive while the XMTP stream is open.
4. The process must have access to the same persistent data directory so it can reuse contacts, conversations, and the XMTP database.
5. The agent must be able to make runtime approval decisions for connection requests and some action requests.

In the CLI, this is `tap message listen`, which installs the handler, starts transport, and then blocks forever.

Relevant code:

- `packages/cli/src/commands/message-listen.ts`
- `packages/cli/src/lib/context.ts`
- `packages/sdk/src/orchestrator.ts`

### 1.5 Important implementation details

- `XmtpTransport.start()` creates an XMTP client, derives a deterministic DB encryption key, and starts a background receive loop with reconnect logic.
- The receive loop uses `client.conversations.streamAllDmMessages()`.
- JSON-RPC responses are matched to in-memory `pendingRequests`.
- Unknown senders are rejected unless the inbound method is `connection/request` and XMTP inbox identity matches the claimed TAP agent identity.
- Known senders are still rejected unless the contact is `active`.

Important current constraints:

- `send()` depends on the live receive loop to observe the response and resolve the pending promise.
- If the process dies during `send()`, `pendingRequests` disappear. A later XMTP response will not satisfy the original caller.
- Inbound request dedupe is process-local and memory-only (`processedIncomingRequests`), not durable across restarts.
- Repo guidance already warns against multiple transport-active processes per identity because replies are process-local and can race with one another.

## 2. Is It Reasonable To Expect Long-Lived Agent Connections?

### Short answer

Yes, but only if we treat agents as services, not as terminal commands.

### Why this is reasonable with XMTP

XMTP's own docs assume a long-running runtime model:

- The stream API is explicitly infinite and intended to stay open.
- Streams include catch-up messages after offline periods.
- Streams automatically retry on failure.
- XMTP recommends persistent local volumes for the database across restarts.
- XMTP recommends process managers such as PM2 because long-running processes will not have perfect uptime.

That is consistent with a production service model: one long-lived process per identity, supervised by PM2/systemd/container orchestration, with a persistent volume.

### Why this is not a good expectation for the current TAP CLI UX

For TAP as currently packaged, the answer is mostly no:

- `tap message listen` is a manual foreground command.
- `tap connect` and `tap message send` start and stop transport around a single request.
- Runtime approvals are tied to the listening process.
- The repo already documents "one transport-active process per identity", which makes a separate sender + listener workflow awkward.

That is acceptable for demos and tests. It is weak as an operational contract for autonomous agents.

## 3. Should We Use Heartbeats Or Scheduled Listening?

### Short answer

Not as the primary model for TAP's current protocol.

### Why heartbeat-only listening is a bad fit today

Heartbeat polling sounds attractive, but it collides with current TAP semantics:

1. `connect` and `message send` are synchronous JSON-RPC calls with response timeouts.
2. `XmtpTransport.send()` expects the caller's own live receive loop to observe the matching response.
3. If the recipient only wakes up every N minutes, the sender will usually time out.
4. If the sender exits after timeout, a later response is operationally useless to the original caller.
5. Because dedupe is in-memory, scheduled wake/sleep patterns increase the chance of replay or double-processing after failures unless we add durable idempotency state.

So a heartbeat scheduler alone does not solve reliability. It mainly trades always-on cost for higher latency and more failure modes.

### Where heartbeat-style sync still helps

XMTP does support sync-based recovery patterns:

- streaming includes catch-up after the last sync
- `syncAll` can fetch new welcomes, unread conversations, and preference updates

That makes a reconciliation loop useful:

- run `syncAll(['allowed'])` on startup
- run it after stream reconnects or suspicious failures
- optionally run it on a slow timer as a safety net

That is different from saying "wake every few minutes instead of running a listener".

## 4. Are There Better Ways With XMTP?

### Better XMTP operating model

Yes. The main improvement is architectural, not a different socket primitive.

Recommended XMTP model for TAP:

1. One resident TAP daemon per identity.
2. The daemon owns the XMTP client, stream, DB, trust store access, and approval hooks.
3. CLI commands become thin clients that talk to the daemon over a local API or Unix socket instead of creating short-lived XMTP sessions.
4. The daemon performs startup reconciliation with `syncAll`.
5. The daemon persists idempotency state for inbound request IDs and outbound request state.

This keeps XMTP's strengths while removing the worst current UX and reliability edges.

### What about websockets?

I did not find official XMTP docs describing a websocket API for server or agent deployments. The documented model is SDK-managed streams, local persistent databases, and optional push-notification infrastructure. XMTP incident details also reference MLS API endpoints that look gRPC-based, which suggests the Node SDK transport is not a simple browser-style websocket you can swap in and manage directly.

Inference:

- Using "websockets instead of long-lived XMTP connections" is probably the wrong framing.
- XMTP already gives you a long-lived streaming abstraction.
- The higher-value question is whether TAP should keep a resident XMTP runtime, not whether TAP should replace it with hand-managed websockets.

### What about XMTP push notifications?

XMTP does support push-notification servers, but that is mainly a wake-up/notification pattern, not a drop-in replacement for TAP's current request/response workflow. It is better suited to:

- mobile or browser clients
- wake-up hints
- inbox/event fanout into another system

For TAP, push-style infrastructure could be used as a bridge:

- XMTP listener receives message
- bridge writes a durable job into an internal queue
- worker or agent process handles the job asynchronously

That is viable, but it is a bigger system than the current "local-first, no backend" model.

## 5. Other Reliability Patterns Worth Considering

### Pattern A: Fast ingress, slow reasoning

Split the system into:

- an always-on ingress process that receives XMTP messages, validates identity, persists an envelope, and quickly acknowledges receipt
- a separate worker that performs slow reasoning or tool execution

This reduces the chance that one expensive agent action blocks the transport loop.

### Pattern B: Make TAP messaging asynchronous

Today TAP behaves like synchronous RPC. That makes online presence mandatory.

A more resilient protocol would separate:

- transport receipt
- application acceptance
- final business response

Possible direction:

- immediate `received: true`
- later `message/action-response` or status update

This would let agents tolerate delayed processing, scheduled wakes, and queue-based execution much better.

### Pattern C: Durable idempotency and replay protection

TAP should persist:

- processed inbound request IDs
- outbound requests awaiting completion
- response correlation data

Without that, restarts are still a correctness risk even if transport reconnects correctly.

### Pattern D: Listener health and self-healing

If XMTP remains primary:

- supervise the process with PM2/systemd
- add health endpoints or heartbeat logs
- alert on restart loops
- reconcile with `syncAll` on restart

### Pattern E: Queue-backed internal transport

If most agents are under one operator, a message queue is a better fit than a wallet-native chat network.

NATS JetStream is a strong example:

- native WebSocket support
- durable consumers
- at-least-once delivery
- ack/redelivery controls
- pull consumers for scalable worker-style processing

This is much closer to the reliability model most agent systems want.

### Pattern F: Federated messaging alternative

If the goal is an open network but XMTP is not the right fit, Matrix is the most obvious alternative category:

- incremental `/sync`
- push gateway model
- established federation patterns

Tradeoff: Matrix is more infrastructure-heavy and less aligned with on-chain wallet identity than XMTP.

## 6. Is XMTP Truly The Best Option?

### XMTP is a good fit if your top priorities are:

- wallet-native identity
- user-owned, interoperable messaging across operators
- end-to-end encrypted agent messaging on an open network
- local-first state with no mandatory TAP backend

### XMTP is a weaker fit if your top priorities are:

- strict operational reliability
- durable job semantics
- easy background processing
- internal multi-agent orchestration under one operator
- low operational surprise during outages

### Practical conclusion

XMTP is reasonable for TAP's current product thesis, but only if TAP adopts a service-style runtime.

If the real product need is "reliable machine-to-machine workflow orchestration", XMTP should not be the only transport under consideration. In that world, TAP should likely:

- keep the identity and trust model
- keep the transport abstraction
- add a second transport that is queue- or webhook-oriented

## 7. Recommendation

### Recommended path for TAP

1. Keep XMTP as the default external transport for now.
2. Build a resident TAP daemon or SDK host process per identity.
3. Change CLI commands to talk to that daemon instead of starting short-lived XMTP sessions.
4. Add startup and post-failure reconciliation with `syncAll`.
5. Persist idempotency and pending-request state.
6. Gradually move TAP away from assuming the remote side is synchronously online for every meaningful response.

### Specific recommendation on heartbeats

Use heartbeats only as a secondary reconciliation mechanism, not as the main listening model.

Good:

- startup reconciliation
- periodic safety sync
- health monitoring

Bad:

- "wake every few minutes instead of running a listener"
- relying on scheduled polling for synchronous connect/send workflows

### Specific recommendation on websockets

Do not spend time trying to replace XMTP's receive model with ad hoc websocket management inside TAP. That is unlikely to address the real problem.

The real problem is runtime shape:

- CLI foreground listener
- short-lived senders
- process-local response correlation
- missing durable replay/idempotency state

### Specific recommendation on alternatives

If you expect most production agents to be autonomous services under your control, start designing a second transport now. The existing `TransportProvider` seam is already the right abstraction for this.

The most pragmatic next transport candidates are:

- `NatsTransport` for reliable internal agent workloads
- `WebhookTransport` or signed HTTP transport for externally reachable agents

XMTP can remain the interoperability transport while a queue or webhook transport handles higher-reliability deployments.

## Sources

### Local code and repo docs

- `packages/core/src/transport/interface.ts`
- `packages/core/src/transport/xmtp.ts`
- `packages/core/src/connection/request-handler.ts`
- `packages/cli/src/commands/connect.ts`
- `packages/cli/src/commands/message-send.ts`
- `packages/cli/src/commands/message-listen.ts`
- `packages/cli/src/lib/context.ts`
- `packages/cli/src/lib/message-conversations.ts`
- `packages/sdk/src/orchestrator.ts`
- `packages/sdk/skills/trusted-agents/messaging/SKILL.md`
- `Agents.md`

### External docs and status pages

- [XMTP: Stream conversations and messages](https://docs.xmtp.org/chat-apps/list-stream-sync/stream)
- [XMTP: Sync conversations and messages](https://docs.xmtp.org/chat-apps/list-stream-sync/sync-and-syncall)
- [XMTP: Understand push notifications](https://docs.xmtp.org/chat-apps/push-notifs/understand-push-notifs)
- [XMTP: Run a push notification server](https://docs.xmtp.org/chat-apps/push-notifs/pn-server)
- [XMTP: Manage agent local database files and installations](https://docs.xmtp.org/agents/build-agents/local-database)
- [XMTP: Deploy an agent](https://docs.xmtp.org/agents/deploy/deploy-agent)
- [XMTP: Process management](https://docs.xmtp.org/agents/deploy/pm2-process-management)
- [XMTP status: Streams missing some messages (July 17, 2025)](https://status.xmtp.org/incidents/01K0CYPM874E5NMYR6CJSEA08R)
- [XMTP status: XMTP API connectivity issues (November 6, 2025)](https://status.xmtp.org/incidents/01K9BHZ4YH7QA2ZEP994PZXW4H)
- [NATS: WebSocket support](https://docs.nats.io/running-a-nats-service/configuration/websocket)
- [NATS: JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [Matrix spec: Client-Server `/sync`](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)
