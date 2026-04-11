# Connection Flow Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the TAP invite+connection flow by collapsing three state files into one, making `tap connect` truly synchronous, fixing the inviter-side ordering bug, and making handlers fully idempotent so any reconnect attempt is self-healing.

**Architecture:** Six-commit refactor inside a single PR. Each commit passes `bun run lint && bun run typecheck && bun run test` on its own so any prefix of the commits could land as a partial PR. Work ordered so later commits depend only on earlier ones; no circular dependencies.

**Tech Stack:** TypeScript (ESM, `.js` imports), Bun test runner, Biome for lint+format, XMTP for transport, ERC-8004 on-chain identity, OWS for signing. Tests live under `packages/*/test/unit/**` and `packages/*/test/integration/**`.

**Authoritative spec:** `docs/superpowers/specs/2026-04-10-connection-flow-simplification-design.md`. Consult this plan for step-by-step actions, consult the spec for rationale and invariants.

---

## File Inventory

Files that will be created, modified, or deleted across all six phases. Use this as a map before diving into tasks.

### Created
- `packages/cli/src/commands/journal-list.ts` — new `tap journal list` CLI command
- `packages/cli/src/commands/journal-show.ts` — new `tap journal show` CLI command
- `packages/core/test/unit/runtime/handler-idempotency.test.ts`
- `packages/core/test/unit/runtime/service.waiters.test.ts`
- `packages/core/test/unit/runtime/service.sync-ordering.test.ts`
- `packages/core/test/unit/runtime/service.recovery.test.ts`
- `packages/core/test/unit/runtime/service.auto-accept.test.ts`
- `packages/core/test/unit/runtime/migration.test.ts`
- `packages/core/test/integration/xmtp.recovery.test.ts`

### Modified
- `packages/core/src/trust/types.ts` — add `"connecting"` to `ConnectionStatus`, add `expiresAt?`
- `packages/core/src/runtime/service.ts` — heaviest file, touched in every phase
- `packages/core/src/connection/request-handler.ts` — idempotency table for `handleConnectionRequest`
- `packages/core/src/runtime/request-journal.ts` — remove `acked`, add `queued`, add `lastError` metadata
- `packages/cli/src/commands/connect.ts` — remove `--yes`, add `--no-wait`, new exit codes
- `packages/cli/src/commands/contacts-remove.ts` — enqueue `connection/revoke` before local delete
- `packages/cli/src/lib/queued-commands.ts` — reduced to thin wrapper (phase 5)
- `packages/cli/src/commands/app.ts` — register `journal-list` and `journal-show`
- `packages/openclaw-plugin/src/registry.ts` — delete `approveConnection` stub, add post-success notification
- `skills/trusted-agents/SKILL.md` — update `tap connect`, add Debugging and Recovery sections
- `CLAUDE.md` — update file layout tree, non-obvious behavior items 15+16, "If You Change X" sections
- `packages/cli/test/e2e/scenarios.ts`, `e2e-mock.test.ts`, `e2e-live.test.ts`

### Deleted
- `packages/core/src/runtime/pending-connect-store.ts`
- `packages/core/src/runtime/command-outbox.ts` (if present) / the corresponding implementation inside `queued-commands.ts`
- `packages/core/test/unit/runtime/command-outbox.test.ts` (replaced by migration tests)
- `packages/cli/src/commands/connect.ts`'s `CONNECT_RECEIPT_TIMEOUT_MS` usage

---

## Global conventions for every task

1. **TDD where it helps, refactor-safe where it doesn't.** New behavior gets tests first. Pure deletions and renames are refactor-safe: run existing tests before the change, make the change, run tests again.
2. **Every commit runs `bun run lint && bun run typecheck && bun run test` before being made.** If any of those fail, fix before committing.
3. **Commit messages follow the repo's conventional-commits style.** Type prefix (`feat`, `fix`, `refactor`, `docs`, `test`), optional scope, imperative subject. Example: `refactor(trust): add "connecting" status and delete pending-connect-store`.
4. **Never use `--no-verify` or bypass hooks.** If a hook fails, fix the cause.
5. **Biome is the formatter.** After large edits, run `bun run format` (if that script exists) or let Biome handle it via the lint step.
6. **Prefer editing over creating.** Create files only when the inventory above says to.
7. **Imports use `.js` extensions** in TypeScript source per repo convention.

---

## Phase 1: R1+R2 — Data model + ordering fix + handler idempotency

**Goal:** Add `"connecting"` status, delete `FilePendingConnectStore`, fix the inviter-side ordering bug, implement the §5.2/§5.3 handler idempotency tables, and remove the `connectInternal` early-return on already-active contacts.

**End state:** All existing tests still pass. The service uses the trust store exclusively for pending-connect state. A failed `connection/result` send on Alice's side leaves her contact unwritten. Running `tap connect` on an already-active contact triggers a fresh handshake. `pending-connects.json` on disk is migrated to `connecting` contacts on first start.

### Task 1.1: Extend `ConnectionStatus` with `"connecting"` and `Contact.expiresAt?`

**Files:**
- Modify: `packages/core/src/trust/types.ts`
- Modify: `packages/core/test/unit/trust/file-trust-store.test.ts`

- [ ] **Step 1.1.1: Read the existing type**

Current `packages/core/src/trust/types.ts:3`:
```ts
export type ConnectionStatus = "active" | "idle" | "stale" | "revoked";
```

- [ ] **Step 1.1.2: Add a failing test for `connecting` round-trip**

Append to `packages/core/test/unit/trust/file-trust-store.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { FileTrustStore } from "../../../src/trust/file-trust-store.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("FileTrustStore — connecting status", () => {
  it("round-trips a connecting contact with expiresAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tap-trust-"));
    const store = new FileTrustStore(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

    await store.addContact({
      connectionId: "conn-1",
      peerAgentId: 42,
      peerChain: "eip155:8453",
      peerOwnerAddress: "0x1111111111111111111111111111111111111111",
      peerDisplayName: "alice",
      peerAgentAddress: "0x2222222222222222222222222222222222222222",
      permissions: { transfer: [], scheduling: [], messaging: [], grantsUpdatedAt: "2026-04-10T00:00:00Z" },
      establishedAt: "2026-04-10T00:00:00Z",
      lastContactAt: "2026-04-10T00:00:00Z",
      status: "connecting",
      expiresAt,
    });

    const fetched = await store.findByAgentId(42, "eip155:8453");
    expect(fetched?.status).toBe("connecting");
    expect(fetched?.expiresAt).toBe(expiresAt);
  });
});
```

- [ ] **Step 1.1.3: Run the test, watch it fail**

Run: `bun run test -- packages/core/test/unit/trust/file-trust-store.test.ts`
Expected: TypeScript errors — `"connecting"` not assignable to `ConnectionStatus`, `expiresAt` not in `Contact`.

- [ ] **Step 1.1.4: Update `types.ts`**

Replace the `ConnectionStatus` and `Contact` declarations:
```ts
export type ConnectionStatus = "connecting" | "active" | "idle" | "stale" | "revoked";

export interface Contact {
  connectionId: string;
  peerAgentId: number;
  peerChain: string;
  peerOwnerAddress: `0x${string}`;
  peerDisplayName: string;
  peerAgentAddress: `0x${string}`;
  permissions: ContactPermissionState;
  establishedAt: string;
  lastContactAt: string;
  status: ConnectionStatus;
  /** ISO timestamp from the invite's `expires` field. Display-only hint for `connecting` contacts; not used for expiry logic. */
  expiresAt?: string;
}
```

- [ ] **Step 1.1.5: Re-run the test**

Run: `bun run test -- packages/core/test/unit/trust/file-trust-store.test.ts`
Expected: All tests pass, including the new one.

- [ ] **Step 1.1.6: Commit**

```bash
git add packages/core/src/trust/types.ts packages/core/test/unit/trust/file-trust-store.test.ts
git -c commit.gpgsign=false commit -m "feat(trust): add 'connecting' status and Contact.expiresAt"
```

### Task 1.2: Implement `handleConnectionRequest` idempotency table

**Files:**
- Modify: `packages/core/src/connection/request-handler.ts`
- Create: `packages/core/test/unit/runtime/handler-idempotency.test.ts`

- [ ] **Step 1.2.1: Read the current request-handler**

Read `packages/core/src/connection/request-handler.ts` in full. Identify where it branches on `existing?.status === "active"`.

- [ ] **Step 1.2.2: Write the failing idempotency tests**

Create `packages/core/test/unit/runtime/handler-idempotency.test.ts` with a table-driven test that exercises every row of spec §5.2. Each row:

```ts
import { describe, expect, it } from "bun:test";
import { handleConnectionRequest } from "../../../src/connection/request-handler.js";
import type { Contact, ITrustStore } from "../../../src/trust/index.js";
import { makeMockResolver, makeConnectionRequestMessage, makeMockTrustStore } from "../../helpers/mocks.js";

describe("handleConnectionRequest — idempotency table (spec §5.2)", () => {
  const statuses = ["missing", "connecting", "active", "idle", "stale", "revoked"] as const;

  for (const initial of statuses) {
    it(`converges to 'active' when existing contact is ${initial}`, async () => {
      const trustStore = makeMockTrustStore();
      if (initial !== "missing") {
        await trustStore.addContact(makeContact({ status: initial }));
      }

      const outcome = await handleConnectionRequest({
        message: makeConnectionRequestMessage({ fromAgentId: 42, fromChain: "eip155:8453" }),
        resolver: makeMockResolver(),
        trustStore,
        ownAgent: { agentId: 7, chain: "eip155:8453" },
      });

      const after = await trustStore.findByAgentId(42, "eip155:8453");
      expect(after?.status).toBe("active");
      expect(outcome.result.status).toBe("accepted");
    });
  }
});

function makeContact(overrides: Partial<Contact>): Contact {
  return {
    connectionId: "conn-x",
    peerAgentId: 42,
    peerChain: "eip155:8453",
    peerOwnerAddress: "0x1111111111111111111111111111111111111111",
    peerDisplayName: "alice",
    peerAgentAddress: "0x2222222222222222222222222222222222222222",
    permissions: { transfer: [], scheduling: [], messaging: [], grantsUpdatedAt: "2026-04-10T00:00:00Z" },
    establishedAt: "2026-04-10T00:00:00Z",
    lastContactAt: "2026-04-10T00:00:00Z",
    status: "active",
    ...overrides,
  };
}
```

The helper files `packages/core/test/helpers/mocks.ts` may not exist yet. If `makeMockResolver` / `makeConnectionRequestMessage` / `makeMockTrustStore` helpers already exist under another name (check `packages/core/test/helpers/`), reuse them; otherwise add the minimal helpers in a new or existing helpers file.

- [ ] **Step 1.2.3: Run tests and confirm some cases fail**

Run: `bun run test -- packages/core/test/unit/runtime/handler-idempotency.test.ts`
Expected: `revoked` case fails (today's handler doesn't treat revoked specially), possibly `idle`/`stale` too.

- [ ] **Step 1.2.4: Update `handleConnectionRequest` to implement the §5.2 table**

Rewrite the existing branching. The function should:
1. Resolve the peer.
2. Look up existing contact by `(from.agentId, from.chain)`.
3. Apply the §5.2 state table:
   - `missing`, `revoked`: create a fresh `active` contact.
   - `connecting`, `idle`, `stale`, `active`: upsert to `active` (touch `lastContactAt`, keep `establishedAt` and `connectionId` if present, keep `permissions` if present).
4. Return `{ peer, contact: updated, result: { status: "accepted", ... } }`.

Do not touch the rejection branch for invalid invites — validation already happens in `processConnectionRequest` before calling the handler, so `handleConnectionRequest` assumes a valid invite.

- [ ] **Step 1.2.5: Re-run the test**

Run: `bun run test -- packages/core/test/unit/runtime/handler-idempotency.test.ts`
Expected: All rows pass.

- [ ] **Step 1.2.6: Commit**

```bash
git add packages/core/src/connection/request-handler.ts packages/core/test/unit/runtime/handler-idempotency.test.ts packages/core/test/helpers/
git -c commit.gpgsign=false commit -m "refactor(connection): make handleConnectionRequest idempotent on all contact states"
```

### Task 1.3: Fix `processConnectionRequest` ordering (R2)

**Files:**
- Modify: `packages/core/src/runtime/service.ts` around lines 1930-2003 and 2851-2897

- [ ] **Step 1.3.1: Write a failing ordering test**

Append to `packages/core/test/unit/runtime/service.test.ts` (or create a new sub-file `service.connect.test.ts` if the file is already large):

```ts
it("does not write the contact as active when connection/result send fails", async () => {
  const { service, trustStore, transport } = makeServiceHarness();
  transport.sendFails = true;

  const inbound = makeValidConnectionRequestMessage({ fromAgentId: 42 });
  await service.__processConnectionRequest(inbound); // exposed for tests via __ prefix or a test harness

  const contact = await trustStore.findByAgentId(42, "eip155:8453");
  expect(contact).toBeNull();
});
```

If service doesn't expose the private processor, use a test harness that drives the transport's `onRequest` callback.

- [ ] **Step 1.3.2: Confirm it fails on the current ordering**

Run the test. Expected: today the handler writes the contact before the send, so the contact exists even when the send fails.

- [ ] **Step 1.3.3: Rewrite `processConnectionRequest` to the spec §5.1 order**

The new order inside `processConnectionRequest`:
1. Validate invite → if invalid, send rejection result and return.
2. Resolve peer.
3. Build result payload: `{ requestId, from, status: "accepted", timestamp }`.
4. Persist outbound journal entry as `pending` (via `sendConnectionResult`'s existing journal path, which currently does this — verify the call order).
5. Call `transport.send()` and await. On failure: update `metadata.lastError` on the journal entry, throw. Contact is NOT written.
6. On success: call `handleConnectionRequest` to upsert the contact per the §5.2 table.
7. Mark the inbound request `completed`.

**Key refactor:** split the current `sendConnectionResult` into two concerns — "persist journal + send wire" and "write contact". Move the "write contact" call to AFTER the send succeeds. The existing `handleConnectionRequest` currently does both in one step; this task moves the contact write out of `handleConnectionRequest` and into `processConnectionRequest` so it happens after the send. Update the test from task 1.2 if the handler's contract changes (now returns planned contact to write, doesn't write directly).

Concretely: change `handleConnectionRequest` to be a pure function that returns `{ peer, plannedContact, result }` without touching the trust store. The caller (`processConnectionRequest`) performs the trust store write only after the send succeeds.

- [ ] **Step 1.3.4: Re-run all runtime tests**

Run: `bun run test -- packages/core/test/unit/runtime/`
Expected: new ordering test passes; existing tests still pass. Any existing tests that depended on `handleConnectionRequest` writing to the trust store need to be updated to call `processConnectionRequest` or to perform the write themselves.

- [ ] **Step 1.3.5: Shrink `retryPendingConnectionResults`**

Search for this function in `service.ts` and simplify. The function currently reconciles Alice-thinks-active-but-send-failed cases. After the ordering fix, the only scenario it needs to handle is: journal has an outbound `pending` `connection/result` entry with `lastError`, and reconciliation should retry the send. On success, call `handleConnectionRequest`'s contact-write step. On failure, update `lastError` and leave the entry.

Delete any code in the current implementation that reconciles trust-store-ahead-of-journal divergence, since the new ordering prevents that divergence.

- [ ] **Step 1.3.6: Run full core test suite**

Run: `bun run test -- packages/core/`
Expected: all pass.

- [ ] **Step 1.3.7: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/src/connection/request-handler.ts packages/core/test/unit/runtime/
git -c commit.gpgsign=false commit -m "fix(runtime): send connection/result before writing contact as active"
```

### Task 1.4: Delete `FilePendingConnectStore` and migrate its call sites

**Files:**
- Delete: `packages/core/src/runtime/pending-connect-store.ts`
- Modify: `packages/core/src/runtime/service.ts` (all `pendingConnectStore` uses)
- Modify: `packages/core/src/runtime/index.ts` (exports)
- Modify: `packages/cli/src/lib/context.ts` and any other instantiation sites
- Modify: `packages/core/test/` — delete any direct tests of `FilePendingConnectStore`

- [ ] **Step 1.4.1: Audit every reference to `pendingConnectStore` and `FilePendingConnectStore`**

Run a grep for both identifiers and list every file. Note what each site does: read, write, delete.

- [ ] **Step 1.4.2: Replace writes on the connector side**

In `service.ts` `connectInternal`, delete the `pendingConnectStore.replaceForPeer(...)` call and replace with an `upsertConnectingContact` call on the trust store. Build the `Contact` directly:

```ts
const expiresAt = new Date(invite.expires * 1000).toISOString();
const connectingContact: Contact = {
  connectionId: existing?.connectionId ?? generateConnectionId(),
  peerAgentId: peerAgent.agentId,
  peerChain: peerAgent.chain,
  peerOwnerAddress: peerAgent.ownerAddress,
  peerDisplayName: peerAgent.registrationFile.name,
  peerAgentAddress: peerAgent.agentAddress,
  permissions: existing?.permissions ?? createEmptyPermissionState(requestedAt),
  establishedAt: existing?.establishedAt ?? requestedAt,
  lastContactAt: requestedAt,
  status: "connecting",
  expiresAt,
};
if (existing) {
  await trustStore.updateContact(existing.connectionId, connectingContact);
} else {
  await trustStore.addContact(connectingContact);
}
```

- [ ] **Step 1.4.3: Replace reads in `handleConnectionResult`**

In `service.ts` `handleConnectionResult`, delete the `pendingConnect = pendingConnectStore.get(result.requestId)` call. Replace the correlation logic:

```ts
const existingContact = await trustStore.findByAgentId(result.from.agentId, result.from.chain);
```

Then implement the §5.3 idempotency table:
- `connecting` → flip to `active` (upsert).
- `active` → touch `lastContactAt`; no status change.
- `missing` → create fresh `active` (see spec §5.3 security note; leave a code comment referencing the XMTP bootstrap sender verification).
- `revoked` → log and return `"duplicate"` without writing.
- `idle` / `stale` → flip to `active`.

Also look up any matching outbound journal entry by `correlationId === result.requestId` and mark it `completed` if found. Use `this.context.requestJournal.getByRequestId` or equivalent.

- [ ] **Step 1.4.4: Delete `pending-connect-store.ts` and its test**

```bash
rm packages/core/src/runtime/pending-connect-store.ts
# Delete direct tests if any exist under packages/core/test/unit/runtime/
```

- [ ] **Step 1.4.5: Remove exports and constructor parameters**

In `packages/core/src/runtime/index.ts`, remove the `pending-connect-store` export. In `service.ts`, remove the `pendingConnectStore` constructor injection and field. In `packages/cli/src/lib/context.ts`, remove the `FilePendingConnectStore` instantiation and the injection site.

- [ ] **Step 1.4.6: Run lint + typecheck + test**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: pass. Any type errors will come from residual references — fix them by following the grep list.

- [ ] **Step 1.4.7: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "refactor(runtime): delete FilePendingConnectStore; use trust store for pending state"
```

### Task 1.5: Implement `handleConnectionResult` idempotency table tests

**Files:**
- Modify: `packages/core/test/unit/runtime/handler-idempotency.test.ts`

- [ ] **Step 1.5.1: Add the §5.3 table tests**

Append to the existing handler-idempotency test file:

```ts
describe("handleConnectionResult — idempotency table (spec §5.3)", () => {
  const cases = [
    { initial: "connecting", expected: "active" },
    { initial: "active", expected: "active" },
    { initial: "missing", expected: "active" },
    { initial: "revoked", expected: "revoked" },
    { initial: "idle", expected: "active" },
    { initial: "stale", expected: "active" },
  ] as const;

  for (const { initial, expected } of cases) {
    it(`from ${initial} → ${expected}`, async () => {
      const harness = makeServiceHarness();
      if (initial !== "missing") {
        await harness.trustStore.addContact(makeContact({ status: initial }));
      }
      await harness.driveConnectionResult({ fromAgentId: 42 });

      const after = await harness.trustStore.findByAgentId(42, "eip155:8453");
      if (expected === "revoked" || (initial === "missing" && expected === "active")) {
        // revoked stays revoked; missing becomes active
      }
      expect(after?.status).toBe(expected);
    });
  }
});
```

`makeServiceHarness` and `driveConnectionResult` are test helpers that invoke `handleConnectionResult` via the service, mocking the transport to deliver a synthetic `connection/result` message. Add helpers to `packages/core/test/helpers/service-harness.ts` if they don't already exist.

- [ ] **Step 1.5.2: Run the tests**

Run: `bun run test -- packages/core/test/unit/runtime/handler-idempotency.test.ts`
Expected: all pass now that §5.3 is implemented in task 1.4.

- [ ] **Step 1.5.3: Commit**

```bash
git add packages/core/test/
git -c commit.gpgsign=false commit -m "test(runtime): cover handleConnectionResult idempotency table"
```

### Task 1.6: Remove `connectInternal` early-return on already-active contacts (§3.1.1)

**Files:**
- Modify: `packages/core/src/runtime/service.ts:882-889`

- [ ] **Step 1.6.1: Write a failing recovery test**

Create `packages/core/test/unit/runtime/service.recovery.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { makeTwoAgentHarness } from "../../helpers/two-agent-harness.js";

describe("recovery — reconnect after Alice wipes (spec §10)", () => {
  it("running tap connect again repairs divergent state", async () => {
    const { alice, bob } = makeTwoAgentHarness();

    // Establish initial connection
    const invite1 = await alice.service.createInvite();
    await bob.service.connect({ inviteUrl: invite1, waitMs: 5000 });
    expect(await bob.trustStore.findByAgentId(alice.agentId, alice.chain))
      .toMatchObject({ status: "active" });

    // Alice wipes her trust store
    await alice.trustStore.clear();

    // Bob is still convinced he's active. Alice creates a new invite.
    const invite2 = await alice.service.createInvite();

    // Bob's reconnect must now actually send a wire request (no early-return)
    const result = await bob.service.connect({ inviteUrl: invite2, waitMs: 5000 });

    expect(result.status).toBe("active");
    expect(await alice.trustStore.findByAgentId(bob.agentId, bob.chain))
      .toMatchObject({ status: "active" });
    expect(await bob.trustStore.findByAgentId(alice.agentId, alice.chain))
      .toMatchObject({ status: "active" });
  });
});
```

`makeTwoAgentHarness` is a new test helper that wires two `TapMessagingService` instances together via an in-memory loopback transport. It may already exist under another name (search `packages/core/test/helpers/`); if not, add it. The loopback transport should deliver messages between the two agents synchronously inside the test.

- [ ] **Step 1.6.2: Run the test — it fails**

Expected: test fails because `connectInternal` returns early on `existing?.status === "active"`, so no wire traffic goes out, and Alice's trust store stays empty.

- [ ] **Step 1.6.3: Delete the early-return in `service.ts:882-889`**

Replace:
```ts
const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
if (existing?.status === "active") {
  return {
    connectionId: existing.connectionId,
    peerName: existing.peerDisplayName,
    peerAgentId: existing.peerAgentId,
    status: "active",
  };
}
```

With:
```ts
const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
// Note: no early-return on existing.status === "active". Intentional for self-healing
// recovery: running `tap connect` must always trigger a fresh handshake so divergent
// state (e.g. peer wiped local data) is repaired. See spec §3.1.1.
```

The rest of `connectInternal` proceeds to upsert the `connecting` contact and send the request regardless of prior state. The subsequent `handleConnectionResult` (§5.3) handles all contact states idempotently.

- [ ] **Step 1.6.4: Re-run the recovery test**

Expected: passes.

- [ ] **Step 1.6.5: Run full core test suite**

Run: `bun run test -- packages/core/`
Expected: all pass.

- [ ] **Step 1.6.6: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/service.recovery.test.ts packages/core/test/helpers/
git -c commit.gpgsign=false commit -m "fix(runtime): remove connect() early-return for self-healing recovery"
```

### Task 1.7: Migration — `pending-connects.json` → `connecting` contacts

**Files:**
- Modify: `packages/core/src/runtime/service.ts` — add `runLegacyStateMigrations()` called from `start()`
- Create: `packages/core/test/unit/runtime/migration.test.ts`

- [ ] **Step 1.7.1: Write the failing migration test**

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeServiceHarness } from "../../helpers/service-harness.js";

describe("legacy state migration", () => {
  it("migrates pending-connects.json into connecting contacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tap-migration-"));
    writeFileSync(
      join(dir, "pending-connects.json"),
      JSON.stringify({
        pendingConnects: [{
          requestId: "req-1",
          peerAgentId: 42,
          peerChain: "eip155:8453",
          peerOwnerAddress: "0x1111111111111111111111111111111111111111",
          peerDisplayName: "alice",
          peerAgentAddress: "0x2222222222222222222222222222222222222222",
          createdAt: "2026-04-09T00:00:00Z",
        }],
      }),
    );

    const { service, trustStore } = makeServiceHarness({ dataDir: dir });
    await service.start();

    const contact = await trustStore.findByAgentId(42, "eip155:8453");
    expect(contact?.status).toBe("connecting");
    expect(existsSync(join(dir, "pending-connects.json"))).toBe(false);
  });

  it("is idempotent — running twice does not double-migrate", async () => {
    // same setup, call start() twice, assert only one contact exists
  });
});
```

- [ ] **Step 1.7.2: Run the test — it fails**

Expected: `pending-connects.json` still exists; no contact was created.

- [ ] **Step 1.7.3: Implement the migration**

Add a private method in `service.ts`:

```ts
private async runLegacyStateMigrations(): Promise<void> {
  await this.migratePendingConnects();
  // Additional migrations (outbox, acked) added in later phases.
}

private async migratePendingConnects(): Promise<void> {
  const path = join(this.context.dataDir, "pending-connects.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return;
    throw err;
  }
  const parsed = JSON.parse(raw) as { pendingConnects?: LegacyPendingConnect[] };
  for (const legacy of parsed.pendingConnects ?? []) {
    const existing = await this.context.trustStore.findByAgentId(legacy.peerAgentId, legacy.peerChain);
    if (existing) continue; // idempotent — already migrated
    await this.context.trustStore.addContact({
      connectionId: generateConnectionId(),
      peerAgentId: legacy.peerAgentId,
      peerChain: legacy.peerChain,
      peerOwnerAddress: legacy.peerOwnerAddress,
      peerDisplayName: legacy.peerDisplayName,
      peerAgentAddress: legacy.peerAgentAddress,
      permissions: createEmptyPermissionState(legacy.createdAt),
      establishedAt: legacy.createdAt,
      lastContactAt: legacy.createdAt,
      status: "connecting",
    });
  }
  await rm(path);
  this.log("info", `Migrated ${parsed.pendingConnects?.length ?? 0} pending-connects to connecting contacts`);
}

interface LegacyPendingConnect {
  requestId: string;
  peerAgentId: number;
  peerChain: string;
  peerOwnerAddress: `0x${string}`;
  peerDisplayName: string;
  peerAgentAddress: `0x${string}`;
  createdAt: string;
}
```

Call `runLegacyStateMigrations()` early in `start()`, before any transport is opened.

- [ ] **Step 1.7.4: Re-run the test**

Expected: passes, including idempotency.

- [ ] **Step 1.7.5: Run the full core suite**

Run: `bun run test -- packages/core/`
Expected: all pass.

- [ ] **Step 1.7.6: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/migration.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): migrate pending-connects.json into connecting contacts on start"
```

### Task 1.8: Sync ordering invariant test (spec §3.3)

**Files:**
- Create: `packages/core/test/unit/runtime/service.sync-ordering.test.ts`

- [ ] **Step 1.8.1: Write the test**

```ts
import { describe, expect, it } from "bun:test";
import { makeTwoAgentHarness } from "../../helpers/two-agent-harness.js";

describe("sync ordering invariant (spec §3.3)", () => {
  it("processes connection/result before subsequent message/send in same sync pass", async () => {
    const { alice, bob } = makeTwoAgentHarness({ deliverMode: "manual" });

    const invite = await alice.service.createInvite();
    // Drive the connect request but hold messages
    void bob.service.connect({ inviteUrl: invite, waitMs: 5000 });
    await alice.drainInbound(); // processes connection/request, enqueues result
    await alice.service.sendMessage(bob.agentId, "hello while offline");

    // Bob's inbox now holds: [connection/result, message/send]
    await bob.drainInbound(); // must process in order

    const contact = await bob.trustStore.findByAgentId(alice.agentId, alice.chain);
    expect(contact?.status).toBe("active");
    const log = await bob.conversationLog(alice.agentId);
    expect(log).toContain("hello while offline");
  });
});
```

- [ ] **Step 1.8.2: Run the test**

Expected: passes if `syncOnce` already processes messages serially. If it fails, audit `syncOnce` to confirm it awaits each handler before the next.

- [ ] **Step 1.8.3: Commit**

```bash
git add packages/core/test/unit/runtime/service.sync-ordering.test.ts packages/core/test/helpers/
git -c commit.gpgsign=false commit -m "test(runtime): enforce per-conversation sync ordering invariant"
```

### Task 1.9: Phase 1 verification

- [ ] **Step 1.9.1: Run the full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: everything passes.

- [ ] **Step 1.9.2: Sanity-check file deletions**

Verify `packages/core/src/runtime/pending-connect-store.ts` is gone and no import references it.

Run: `grep -r "pending-connect-store\|FilePendingConnectStore\|PendingConnectRecord" packages/ || echo "clean"`
Expected: `clean` (or only test migration helpers that reference the legacy shape).

---

## Phase 2: R4 — Journal state machine cleanup

**Goal:** Remove the dead `acked` status, add the new `lastError` metadata field, migrate legacy entries. **`queued` is NOT added in this phase** — it arrives in phase 5 when the outbox is folded in.

### Task 2.1: Remove `acked` from `RequestJournalStatus`

**Files:**
- Modify: `packages/core/src/runtime/request-journal.ts`
- Modify: `packages/core/src/runtime/service.ts:1546` (the one site that sets it)
- Modify: `packages/core/test/unit/runtime/request-journal.test.ts`

- [ ] **Step 2.1.1: Write a failing test for the new enum**

Add to `request-journal.test.ts`:

```ts
it("does not include 'acked' in RequestJournalStatus", () => {
  // Compile-time check: if "acked" is still in the union, this type assertion
  // will silently allow it; instead, assert via runtime validation at the
  // FileRequestJournal load path that legacy "acked" is rewritten to "pending".
  const entry: RequestJournalStatus[] = ["pending", "completed"];
  expect(entry).toHaveLength(2);
});
```

- [ ] **Step 2.1.2: Update the type and remove the `acked` call site**

In `request-journal.ts:8`:
```ts
export type RequestJournalStatus = "pending" | "completed";
```

(`queued` is added later in phase 5.)

In `service.ts` around line 1546, delete the `updateStatus(requestId, "acked")` block entirely. The comment explaining it should also go.

- [ ] **Step 2.1.3: Run full test suite**

Run: `bun run test -- packages/core/`
Expected: all pass (type system catches any residual `"acked"` references).

- [ ] **Step 2.1.4: Commit**

```bash
git add packages/core/src/runtime/ packages/core/test/unit/runtime/request-journal.test.ts
git -c commit.gpgsign=false commit -m "refactor(runtime): remove dead 'acked' journal status"
```

### Task 2.2: Add `metadata.lastError` shape

**Files:**
- Modify: `packages/core/src/runtime/request-journal.ts`
- Modify: `packages/core/test/unit/runtime/request-journal.test.ts`

- [ ] **Step 2.2.1: Define the `lastError` type**

In `request-journal.ts`, add near the `RequestJournalMetadata` type:

```ts
export interface RequestJournalLastError {
  message: string;
  at: string;
  attempts: number;
}

/** Metadata carried on a request journal entry. Structured fields are recognised by the runtime; unknown keys are preserved opaquely. */
type RequestJournalMetadata = Record<string, unknown> & {
  lastError?: RequestJournalLastError;
};
```

- [ ] **Step 2.2.2: Write test for `lastError` persistence**

```ts
it("persists and retrieves metadata.lastError on a pending entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tap-journal-"));
  const journal = new FileRequestJournal(dir);
  await journal.putOutbound({
    requestId: "req-1",
    requestKey: "outbound:req-1",
    direction: "outbound",
    kind: "request",
    method: "connection/request",
    peerAgentId: 42,
    status: "pending",
  });
  await journal.updateMetadata("req-1", {
    lastError: { message: "xmtp timeout", at: "2026-04-10T00:00:00Z", attempts: 1 },
  });

  const fetched = await journal.getByRequestId("req-1");
  expect(fetched?.metadata?.lastError?.attempts).toBe(1);
});
```

- [ ] **Step 2.2.3: Run the test**

Expected: passes without code changes (the metadata bag already existed, we just typed a new field).

- [ ] **Step 2.2.4: Add a small helper `recordSendFailure`**

In `service.ts` or a new file under `packages/core/src/runtime/`:

```ts
async function recordSendFailure(
  journal: IRequestJournal,
  requestId: string,
  error: unknown,
): Promise<void> {
  const existing = await journal.getByRequestId(requestId);
  const attempts = (existing?.metadata?.lastError as RequestJournalLastError | undefined)?.attempts ?? 0;
  await journal.updateMetadata(requestId, {
    ...(existing?.metadata ?? {}),
    lastError: {
      message: error instanceof Error ? error.message : String(error),
      at: nowISO(),
      attempts: attempts + 1,
    },
  });
}
```

Use this helper anywhere the service catches a send/processing error on a `pending` entry. Do not call it on entries that will be deleted (unrecoverable errors still delete per spec §1.3).

- [ ] **Step 2.2.5: Commit**

```bash
git add packages/core/src/runtime/ packages/core/test/unit/runtime/request-journal.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): add RequestJournalEntry metadata.lastError for debugging"
```

### Task 2.3: Migration — rewrite legacy `acked` entries

**Files:**
- Modify: `packages/core/src/runtime/request-journal.ts` (load path)
- Modify: `packages/core/test/unit/runtime/migration.test.ts`

- [ ] **Step 2.3.1: Write the failing migration test**

Append to `migration.test.ts`:

```ts
it("rewrites legacy 'acked' entries to 'pending' on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tap-migration-"));
  writeFileSync(
    join(dir, "request-journal.json"),
    JSON.stringify({
      entries: [{
        requestId: "req-legacy",
        requestKey: "outbound:req-legacy",
        direction: "outbound",
        kind: "request",
        method: "message/send",
        peerAgentId: 42,
        status: "acked",
        createdAt: "2026-04-09T00:00:00Z",
        updatedAt: "2026-04-09T00:00:00Z",
      }],
    }),
  );

  const journal = new FileRequestJournal(dir);
  const entry = await journal.getByRequestId("req-legacy");
  expect(entry?.status).toBe("pending");
});
```

- [ ] **Step 2.3.2: Implement the load-time rewrite**

In `FileRequestJournal.load()`, after parsing:

```ts
private async load(): Promise<RequestJournalFile> {
  // ... existing read ...
  const parsed = JSON.parse(raw) as RequestJournalFile;
  // Legacy migration: "acked" is collapsed into "pending" per spec §1.3 / §6 step 3.
  let dirty = false;
  for (const entry of parsed.entries ?? []) {
    if ((entry.status as string) === "acked") {
      entry.status = "pending";
      dirty = true;
    }
  }
  const file = Array.isArray(parsed.entries) ? parsed : { entries: [] };
  if (dirty) {
    // Persist the rewrite so we don't re-migrate on every load.
    await this.save(file);
  }
  return file;
}
```

Because `load()` is called from many places and must be idempotent, the dirty-save is only triggered when a rewrite actually happens. After one successful save, subsequent loads are no-ops.

- [ ] **Step 2.3.3: Re-run the test**

Expected: passes.

- [ ] **Step 2.3.4: Commit**

```bash
git add packages/core/src/runtime/request-journal.ts packages/core/test/unit/runtime/migration.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): rewrite legacy 'acked' journal entries to 'pending'"
```

### Task 2.4: Phase 2 verification

- [ ] **Step 2.4.1: Full suite run**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

---

## Phase 3: R1.5 — Remove `approveConnection` hook + revoke-on-remove

**Goal:** Delete the `approveConnection` hook entirely (connection requests are now auto-accepted on valid invites), replace the inbound escalation notification with a post-success info event, and make `tap contacts remove` send `connection/revoke` before deleting locally.

### Task 3.1: Delete `approveConnection` from the hook interface

**Files:**
- Modify: `packages/core/src/runtime/service.ts` (hook interface declaration and `processConnectionRequest` usage)
- Modify: `packages/sdk/src/notification.ts` or wherever `NotificationAdapter` is declared (search for `approveConnection`)
- Modify: `packages/openclaw-plugin/src/registry.ts` (delete the stub)

- [ ] **Step 3.1.1: Find every reference**

Run: `grep -rn "approveConnection" packages/`
List every file. Expect: type declaration, OpenClaw plugin stub, service.ts usage, and possibly tests.

- [ ] **Step 3.1.2: Write a failing auto-accept test**

Create `packages/core/test/unit/runtime/service.auto-accept.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { makeTwoAgentHarness } from "../../helpers/two-agent-harness.js";

describe("connection request auto-accept (spec §1.5)", () => {
  it("accepts a valid inbound request without any approval hook", async () => {
    const { alice, bob } = makeTwoAgentHarness();
    // Note: no approveConnection hook registered anywhere — the API is gone.

    const invite = await alice.service.createInvite();
    const result = await bob.service.connect({ inviteUrl: invite, waitMs: 5000 });

    expect(result.status).toBe("active");
    expect(await alice.trustStore.findByAgentId(bob.agentId, bob.chain))
      .toMatchObject({ status: "active" });
  });
});
```

- [ ] **Step 3.1.3: Delete the hook field from the interface**

In the file declaring `NotificationAdapter` (likely `packages/sdk/src/notification.ts` or `packages/core/src/runtime/service.ts` hook types), remove the `approveConnection?: (...) => Promise<boolean | null>;` line. Remove any related types.

- [ ] **Step 3.1.4: Delete the `approveConnection` block in `processConnectionRequest`**

In `service.ts` lines 1957-1988, delete the entire `if (this.hooks.approveConnection ...)` block. The method proceeds straight from invite validation to `handleConnectionRequest`.

Also remove the `options?: { skipApprovalHook?: boolean }` parameter — no longer needed.

- [ ] **Step 3.1.5: Delete the OpenClaw plugin stub**

In `packages/openclaw-plugin/src/registry.ts`, find the `approveConnection: async () => null` line and delete it along with any related notification/escalation code that fires on inbound `connection/request`. Keep `approveTransfer` untouched.

- [ ] **Step 3.1.6: Delete the `CONNECTION_REQUEST` branch of `resolvePending`**

Search the plugin for `CONNECTION_REQUEST` and `resolvePending`. Delete the branch that handles connection requests. The function now only processes `ACTION_REQUEST` entries. If the entry kind discriminator is no longer needed, simplify further.

- [ ] **Step 3.1.7: Run tests**

Run: `bun run test -- packages/core/ packages/openclaw-plugin/ packages/sdk/`
Expected: the auto-accept test passes; existing tests that asserted on the hook's behaviour are either updated or deleted.

- [ ] **Step 3.1.8: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "refactor: delete approveConnection hook; auto-accept valid invites"
```

### Task 3.2: Post-success `connection-established` notification in the OpenClaw plugin

**Files:**
- Modify: `packages/openclaw-plugin/src/registry.ts` (or the event pipeline file — search for `emitEvent`)

- [ ] **Step 3.2.1: Find the emitEvent wiring**

Search for `emitEvent` in `packages/openclaw-plugin/`. It's likely called from the service's hooks or a listener callback.

- [ ] **Step 3.2.2: Emit on successful connection**

Hook into the service's `emitEvent` or add a new hook callback (e.g. `onConnectionEstablished`) fired at the end of `processConnectionRequest` after the contact is written. Pass the peer details to the notification pipeline classified as `info`, not `escalation`.

If the service doesn't expose such a callback, add one:

```ts
// in service.ts hook interface
onConnectionEstablished?: (peer: { peerAgentId: number; peerName: string; peerChain: string }) => void;
```

Call it at the end of `processConnectionRequest`'s success path. The OpenClaw plugin wires it to `enqueueNotification({ kind: "connection-established", severity: "info", ... })`.

- [ ] **Step 3.2.3: Add a test for the notification emission**

In `packages/openclaw-plugin/test/`, add a unit test that mocks the `emitEvent` collector and verifies a `connection-established` event is fired when a connection request is processed.

- [ ] **Step 3.2.4: Commit**

```bash
git add packages/openclaw-plugin/ packages/core/
git -c commit.gpgsign=false commit -m "feat(openclaw): emit post-success connection-established notification"
```

### Task 3.3: `tap contacts remove` sends `connection/revoke`

**Files:**
- Modify: `packages/cli/src/commands/contacts-remove.ts`
- Modify: `packages/cli/test/remove.test.ts` (or contacts-remove.test.ts — check actual file)
- Possibly modify: `packages/core/src/runtime/service.ts` to expose a `revokeConnection(peer)` method

- [ ] **Step 3.3.1: Check whether service exposes a revoke method**

Search `service.ts` for `revokeConnection` or `sendConnectionRevoke`. If it exists, reuse. If not, add one that:
1. Builds a `connection/revoke` protocol message.
2. Persists an outbound journal entry (`pending` or — in phase 5 — `queued`).
3. Calls `transport.send`.
4. On success, marks the entry `completed`. On failure, records `lastError` and throws.

- [ ] **Step 3.3.2: Write a failing test**

In the contacts-remove test file:

```ts
it("sends connection/revoke before deleting the local contact", async () => {
  const { service, trustStore, transport } = makeServiceHarness();
  await trustStore.addContact(makeContact({ peerAgentId: 42, status: "active" }));

  await removeContactCommand({ peer: "alice", service, trustStore });

  expect(transport.sent).toContainEqual(
    expect.objectContaining({ method: "connection/revoke", peerAgentId: 42 }),
  );
  expect(await trustStore.findByAgentId(42, "eip155:8453")).toBeNull();
});
```

- [ ] **Step 3.3.3: Update `contacts-remove.ts`**

The new flow:
1. Resolve the target contact in the trust store.
2. Call `service.revokeConnection(contact)` — this builds + sends the revoke.
3. On success OR on a non-fatal error (e.g., transport unavailable), proceed to delete the local contact. Log a warning if the revoke couldn't be delivered.
4. Return success.

The local delete runs regardless of revoke delivery (spec §3.4 option 1 — deliver later asynchronously once outbox/queued path exists in phase 5).

- [ ] **Step 3.3.4: Run the test**

Expected: passes.

- [ ] **Step 3.3.5: Commit**

```bash
git add packages/cli/src/commands/contacts-remove.ts packages/cli/test/ packages/core/src/runtime/service.ts
git -c commit.gpgsign=false commit -m "feat(cli): contacts remove sends connection/revoke before local delete"
```

### Task 3.4: Phase 3 verification

- [ ] **Step 3.4.1: Full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: pass.

- [ ] **Step 3.4.2: Confirm zero remaining `approveConnection` references**

Run: `grep -rn "approveConnection" packages/ || echo "clean"`
Expected: `clean` or only historical tests that were intentionally kept.

---

## Phase 4: R3+R6 — Sync `connect()` + remove pre-prompt

**Goal:** Rewrite `TapMessagingService.connect()` to be truly synchronous using in-memory waiters. Remove `CONNECT_RECEIPT_TIMEOUT_MS`. Remove the CLI's `--yes` prompt and add `--no-wait`. Implement wire-level idempotency by reusing existing non-terminal outbound journal entries.

### Task 4.1: Add `inFlightWaiters` map to the service

**Files:**
- Modify: `packages/core/src/runtime/service.ts` — add `private inFlightWaiters: Map<string, Waiter>` and helper methods

- [ ] **Step 4.1.1: Define the `Waiter` type and the map**

In `service.ts` near other private field declarations:

```ts
interface ConnectWaiter {
  requestId: string;
  peerAgentId: number;
  resolve: (outcome: { contact: Contact }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// in TapMessagingService:
private readonly inFlightWaiters = new Map<string, ConnectWaiter>();
```

- [ ] **Step 4.1.2: Add register/clear helpers**

```ts
private registerConnectWaiter(requestId: string, peerAgentId: number, timeoutMs: number): Promise<{ contact: Contact }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.inFlightWaiters.delete(requestId);
      reject(new ConnectWaiterTimeoutError(requestId));
    }, timeoutMs);
    this.inFlightWaiters.set(requestId, { requestId, peerAgentId, resolve, reject, timer });
  });
}

private resolveConnectWaiter(requestId: string, contact: Contact): void {
  const waiter = this.inFlightWaiters.get(requestId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  this.inFlightWaiters.delete(requestId);
  waiter.resolve({ contact });
}
```

Define `ConnectWaiterTimeoutError` as a simple `class ConnectWaiterTimeoutError extends Error {}` — it is caught and translated, never surfaced directly.

- [ ] **Step 4.1.3: Wire into `handleConnectionResult`**

After the contact is written as `active` in `handleConnectionResult`, call `this.resolveConnectWaiter(result.requestId, contact)`. This fires any local promise waiting on that request.

- [ ] **Step 4.1.4: Clear all waiters on `stop()`**

In `service.stop()`:
```ts
for (const waiter of this.inFlightWaiters.values()) {
  clearTimeout(waiter.timer);
  waiter.reject(new Error("service stopped"));
}
this.inFlightWaiters.clear();
```

- [ ] **Step 4.1.5: Write unit tests for the waiter lifecycle**

Create `packages/core/test/unit/runtime/service.waiters.test.ts`:

```ts
describe("connect waiter lifecycle", () => {
  it("resolves when matching result arrives", async () => { /* ... */ });
  it("times out after the specified duration", async () => { /* ... */ });
  it("clears all waiters on service.stop()", async () => { /* ... */ });
  it("ignores results for unknown requestIds", async () => { /* ... */ });
});
```

- [ ] **Step 4.1.6: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/service.waiters.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): add inFlightWaiters map for synchronous connect()"
```

### Task 4.2: Rewrite `connect()` to use waiters and `waitMs`

**Files:**
- Modify: `packages/core/src/runtime/service.ts` (`connectInternal` and public `connect`)

- [ ] **Step 4.2.1: Write the new contract test**

In `service.connect.test.ts`:

```ts
it("resolves to active when connection/result arrives within waitMs", async () => {
  const { alice, bob } = makeTwoAgentHarness();
  const invite = await alice.service.createInvite();
  const start = Date.now();
  const result = await bob.service.connect({ inviteUrl: invite, waitMs: 2000 });
  expect(result.status).toBe("active");
  expect(Date.now() - start).toBeLessThan(2000);
});

it("returns pending when waitMs expires before the result arrives", async () => {
  const { alice, bob } = makeTwoAgentHarness({ deliverMode: "manual" });
  const invite = await alice.service.createInvite();
  // Don't drain Alice's inbox — no result will come back.
  const result = await bob.service.connect({ inviteUrl: invite, waitMs: 200 });
  expect(result.status).toBe("pending");
});

it("fire-and-forget with waitMs=0 returns immediately", async () => {
  const { alice, bob } = makeTwoAgentHarness();
  const invite = await alice.service.createInvite();
  const result = await bob.service.connect({ inviteUrl: invite, waitMs: 0 });
  expect(result.status).toBe("pending");
});
```

- [ ] **Step 4.2.2: Rewrite `connectInternal`**

The new structure (see spec §3.1 for the full narrative):

```ts
async connect(params: { inviteUrl: string; waitMs?: number }): Promise<TapConnectResult> {
  const waitMs = params.waitMs ?? 30_000;
  const invite = parseInviteUrl(params.inviteUrl);
  // ... validation (unchanged) ...
  const peerAgent = await this.context.resolver.resolve(invite.agentId, invite.chain);
  // ... invite verification (unchanged) ...

  return await this.withTransportSession(async () => {
    const { trustStore, transport, requestJournal } = this.context;

    // Upsert connecting contact BEFORE any wire traffic
    await this.upsertConnectingContact(peerAgent, invite);

    // Wire-level idempotency: reuse existing non-terminal outbound entry if any
    const existing = await this.findInFlightOutboundConnectRequest(peerAgent);
    const requestId = existing?.requestId ?? generateNonce();

    const rpcRequest = buildConnectionRequest({ /* ... */, id: requestId });
    const waiter = waitMs > 0 ? this.registerConnectWaiter(requestId, peerAgent.agentId, waitMs) : null;

    try {
      await transport.send(peerAgent.agentId, rpcRequest, {
        peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
      });
    } catch (error) {
      if (waiter) this.inFlightWaiters.delete(requestId);
      throw error;
    }

    // Journal the outbound entry as pending (skipping queued)
    await requestJournal.putOutbound({
      requestId,
      requestKey: `outbound:${requestId}`,
      direction: "outbound",
      kind: "request",
      method: "connection/request",
      peerAgentId: peerAgent.agentId,
      status: "pending",
    });

    if (!waiter) {
      return this.buildConnectReturn(peerAgent, "pending");
    }

    try {
      await waiter;
      return this.buildConnectReturn(peerAgent, "active");
    } catch (err) {
      if (err instanceof ConnectWaiterTimeoutError) {
        return this.buildConnectReturn(peerAgent, "pending");
      }
      throw err;
    }
  });
}
```

Helper methods:
- `upsertConnectingContact(peerAgent, invite)`: writes the `connecting` row per task 1.4.
- `findInFlightOutboundConnectRequest(peerAgent)`: scans journal for `direction=outbound, method=connection/request, peerAgentId=X, status in {queued, pending}`.
- `buildConnectReturn(peerAgent, status)`: composes the `TapConnectResult` from the latest trust store state.

Do not throw on timeout. Return `{ status: "pending", ... }`.

- [ ] **Step 4.2.3: Delete `CONNECT_RECEIPT_TIMEOUT_MS`**

Find all references:
```bash
grep -rn "CONNECT_RECEIPT_TIMEOUT_MS" packages/
```

Delete the constant declaration and every usage. The new `waitMs` supersedes it. The old timeout was a transport-level concern; the new logic uses `withTransportSession` + waiter for the same purpose.

- [ ] **Step 4.2.4: Add the idempotency test**

```ts
it("re-running connect reuses the existing non-terminal journal entry", async () => {
  const { alice, bob } = makeTwoAgentHarness({ deliverMode: "manual" });
  const invite = await alice.service.createInvite();

  const firstPromise = bob.service.connect({ inviteUrl: invite, waitMs: 10_000 });
  // Wait until the outbound entry is written
  await waitUntil(async () => (await bob.journal.list("outbound")).length > 0);
  const firstId = (await bob.journal.list("outbound"))[0].requestId;

  const secondPromise = bob.service.connect({ inviteUrl: invite, waitMs: 10_000 });
  const outbound = await bob.journal.list("outbound");
  expect(outbound).toHaveLength(1); // same entry, no duplicate
  expect(outbound[0].requestId).toBe(firstId);

  // Drain Alice to complete the flow
  await alice.drainInbound();
  await bob.drainInbound();
  await Promise.all([firstPromise, secondPromise]);
});
```

- [ ] **Step 4.2.5: Run the full test suite**

Run: `bun run test -- packages/core/`
Expected: all pass.

- [ ] **Step 4.2.6: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/
git -c commit.gpgsign=false commit -m "feat(runtime): connect() is synchronous with waitMs; wire-level idempotency"
```

### Task 4.3: CLI — remove `--yes`, add `--no-wait`, update exit codes

**Files:**
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/test/` — any tests touching connect flags

- [ ] **Step 4.3.1: Audit flags and prompts**

Read `packages/cli/src/commands/connect.ts` in full. Identify:
- The `--yes` flag declaration and the `promptYesNo` call.
- The `--wait-seconds` flag.
- The current exit code logic.

- [ ] **Step 4.3.2: Write tests for new flag behavior**

In `packages/cli/test/message-flags.test.ts` or a dedicated `connect-flags.test.ts`:

```ts
it("blocks for default 30s and exits 0 on active", async () => { /* ... */ });
it("exits 2 when the wait times out and prints the recovery hint", async () => { /* ... */ });
it("--no-wait returns immediately with status=pending", async () => { /* ... */ });
it("--wait-seconds 0 is equivalent to --no-wait", async () => { /* ... */ });
it("no --yes flag exists", () => { /* assert parser rejects --yes */ });
```

- [ ] **Step 4.3.3: Update the command**

Delete the `--yes` option and the `promptYesNo` block. Add `--no-wait` as a boolean. Parse `--wait-seconds` as-is but default to 30 when neither is set. Convert to `waitMs` for the service call: `--no-wait` → 0, `--wait-seconds N` → `N * 1000`, default → 30_000.

Exit codes:
```ts
if (result.status === "active") {
  process.exit(0);
} else if (noWait || waitSeconds === 0) {
  info("Connection queued. Run 'tap message sync' to check later.", opts);
  process.exit(0);
} else {
  info("⏳ Connection pending — peer hasn't responded yet. Run 'tap message sync' later to check.", opts);
  process.exit(2);
}
```

- [ ] **Step 4.3.4: Run CLI tests**

Run: `bun run test -- packages/cli/`
Expected: pass.

- [ ] **Step 4.3.5: Commit**

```bash
git add packages/cli/src/commands/connect.ts packages/cli/test/
git -c commit.gpgsign=false commit -m "feat(cli): tap connect blocks by default; add --no-wait; remove --yes"
```

### Task 4.4: Phase 4 verification

- [ ] **Step 4.4.1: Full suite + docs check**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: pass.

- [ ] **Step 4.4.2: Grep for dead references**

```bash
grep -rn "CONNECT_RECEIPT_TIMEOUT_MS\|promptYesNo.*connect\|pendingConnectStore" packages/ || echo "clean"
```

Expected: `clean`.

---

## Phase 5: R5 — Fold outbox into journal

**Goal:** Add `"queued"` to the journal status enum, delete `FileTapCommandOutbox`, reduce `runOrQueueTapCommand` to a thin wrapper over the journal, update the plugin drain loop to consume `queued` entries, add the migration, and add `tap journal list` / `tap journal show` CLI.

### Task 5.1: Add `"queued"` status

**Files:**
- Modify: `packages/core/src/runtime/request-journal.ts`
- Modify: `packages/core/test/unit/runtime/request-journal.test.ts`

- [ ] **Step 5.1.1: Extend the enum**

```ts
export type RequestJournalStatus = "queued" | "pending" | "completed";
```

- [ ] **Step 5.1.2: Add listing helper for queued entries**

```ts
listQueued(): Promise<RequestJournalEntry[]>;
```

Implementation filters `status === "queued"`.

- [ ] **Step 5.1.3: Add a test**

```ts
it("lists only queued outbound entries", async () => {
  // create one queued, one pending, one completed — assert listQueued returns the queued one
});
```

- [ ] **Step 5.1.4: Commit**

```bash
git add packages/core/src/runtime/request-journal.ts packages/core/test/unit/runtime/request-journal.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): add 'queued' status and listQueued() to request journal"
```

### Task 5.2: Migration — outbox file → journal queued entries

**Files:**
- Modify: `packages/core/src/runtime/service.ts` — add `migrateOutbox()` to `runLegacyStateMigrations`
- Modify: `packages/core/test/unit/runtime/migration.test.ts`

- [ ] **Step 5.2.1: Identify the outbox file format**

Read `packages/core/src/runtime/command-outbox.ts` or `packages/cli/src/lib/queued-commands.ts` to understand the on-disk shape of `tap-commands-outbox.json`. Document the fields.

- [ ] **Step 5.2.2: Write a failing migration test**

```ts
it("migrates tap-commands-outbox.json to queued journal entries", async () => {
  const dir = mkdtempSync(...);
  writeFileSync(join(dir, "tap-commands-outbox.json"), JSON.stringify({
    jobs: [{ id: "job-1", type: "connect", payload: { inviteUrl: "https://..." }, createdAt: "..." }],
  }));

  const { service, journal } = makeServiceHarness({ dataDir: dir });
  await service.start();

  const queued = await journal.listQueued();
  expect(queued).toHaveLength(1);
  expect(queued[0].metadata?.commandType).toBe("connect");
  expect(existsSync(join(dir, "tap-commands-outbox.json"))).toBe(false);
});
```

- [ ] **Step 5.2.3: Implement `migrateOutbox` and wire into `runLegacyStateMigrations`**

Parse the legacy file, for each job generate a fresh `requestId = generateNonce()`, write a `queued` outbound journal entry with the command type and payload in `metadata`, delete the outbox file. Idempotent (skip if file missing).

Then extend the existing `runLegacyStateMigrations` method added in Task 1.7:

```ts
private async runLegacyStateMigrations(): Promise<void> {
  await this.migratePendingConnects();
  await this.migrateOutbox();
  // acked → pending migration is handled lazily at journal load-time (Task 2.3), not here.
}
```

- [ ] **Step 5.2.4: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/migration.test.ts
git -c commit.gpgsign=false commit -m "feat(runtime): migrate command outbox to queued journal entries"
```

### Task 5.3: Reduce `runOrQueueTapCommand` to a journal wrapper

**Files:**
- Modify: `packages/cli/src/lib/queued-commands.ts`
- Delete: `packages/core/src/runtime/command-outbox.ts` (if it exists)
- Delete: `packages/core/test/unit/runtime/command-outbox.test.ts`

- [ ] **Step 5.3.1: Audit current usage**

Read `queued-commands.ts` in full. Note how it's called from each CLI command.

- [ ] **Step 5.3.2: Rewrite the wrapper**

New implementation:

```ts
export async function runOrQueueTapCommand<T>(
  dataDir: string,
  command: { type: string; payload: unknown },
  execute: () => Promise<T>,
  options?: { requestedBy?: string; waitMs?: number },
): Promise<QueuedCommandOutcome<T>> {
  try {
    // Attempt to acquire the transport lock and run inline
    return { kind: "completed", result: await execute() };
  } catch (err) {
    if (!isTransportOwnershipError(err)) throw err;

    // Transport is busy — write a queued journal entry and poll
    const journal = new FileRequestJournal(dataDir);
    const requestId = generateNonce();
    await journal.putOutbound({
      requestId,
      requestKey: `outbound:${requestId}`,
      direction: "outbound",
      kind: "request",
      method: `command/${command.type}`,
      peerAgentId: 0, // commands are self-targeted at this layer
      status: "queued",
      metadata: { commandType: command.type, commandPayload: command.payload },
    });
    return { kind: "queued", requestId };
  }
}
```

Delete any retry/polling logic for "wait briefly" — that belongs at the CLI level where the user already specified `--wait-seconds`.

- [ ] **Step 5.3.3: Delete the old outbox implementation**

```bash
rm packages/core/src/runtime/command-outbox.ts
rm packages/core/test/unit/runtime/command-outbox.test.ts
```

Remove exports of `FileTapCommandOutbox` from `packages/core/src/runtime/index.ts`.

- [ ] **Step 5.3.4: Run tests**

Run: `bun run test`
Expected: any CLI tests that checked the outbox directly need updating to check the journal instead. Fix those.

- [ ] **Step 5.3.5: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "refactor(cli): fold command outbox into request journal 'queued' state"
```

### Task 5.4: Plugin drain loop consumes `queued` entries

**Files:**
- Modify: `packages/openclaw-plugin/src/` (the file that drives the background loop — search for `FileTapCommandOutbox` or the drain function)

- [ ] **Step 5.4.1: Find the current drain loop**

Search `packages/openclaw-plugin/` for `outbox` and the periodic task scheduler.

- [ ] **Step 5.4.2: Rewrite to scan `listQueued()`**

The loop:
1. Every N seconds (existing interval), call `journal.listQueued()`.
2. For each entry, determine the command type from `metadata.commandType` and dispatch to the appropriate executor (`connect`, `message/send`, etc.).
3. On success, transition the entry from `queued` → `pending` → `completed` as the wire exchange progresses.
4. On failure, record `lastError` on the entry; leave it as `queued` for the next attempt.

- [ ] **Step 5.4.3: Add a test**

In the plugin tests, verify that a `queued` entry is drained and completed on the next loop tick.

- [ ] **Step 5.4.4: Commit**

```bash
git add packages/openclaw-plugin/
git -c commit.gpgsign=false commit -m "feat(openclaw): drain queued journal entries in background loop"
```

### Task 5.5: `tap journal list` and `tap journal show` CLI commands

**Files:**
- Create: `packages/cli/src/commands/journal-list.ts`
- Create: `packages/cli/src/commands/journal-show.ts`
- Modify: `packages/cli/src/commands/app.ts` (register the new subcommands)
- Create: `packages/cli/test/journal.test.ts`

- [ ] **Step 5.5.1: Write the test**

```ts
it("journal list prints all in-flight entries", async () => {
  const dir = mkdtempSync(...);
  const journal = new FileRequestJournal(dir);
  await journal.putOutbound({ /* pending entry */ });

  const output = await runCli(["journal", "list", "--data-dir", dir]);
  expect(output).toContain("pending");
  expect(output).toContain("connection/request");
});

it("journal show <id> prints the full entry including lastError", async () => {
  /* similar */
});
```

- [ ] **Step 5.5.2: Implement the commands**

Minimal read-only handlers. `list` prints a table: `status | direction | method | peer | age | lastError?`. `show` prints the entire entry as formatted JSON plus a human-readable summary.

Output format follows existing CLI conventions (JSON output with `--json`, otherwise tables).

- [ ] **Step 5.5.3: Register in `app.ts`**

Add the command registrations following the pattern of existing commands like `contacts-list`.

- [ ] **Step 5.5.4: Run the tests**

Expected: pass.

- [ ] **Step 5.5.5: Commit**

```bash
git add packages/cli/src/commands/journal-list.ts packages/cli/src/commands/journal-show.ts packages/cli/src/commands/app.ts packages/cli/test/journal.test.ts
git -c commit.gpgsign=false commit -m "feat(cli): add tap journal list and tap journal show commands"
```

### Task 5.6: Phase 5 verification

- [ ] **Step 5.6.1: Full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: pass.

- [ ] **Step 5.6.2: Grep for deleted concepts**

```bash
grep -rn "FileTapCommandOutbox\|tap-commands-outbox\|command-outbox" packages/ || echo "clean"
```

Expected: `clean` (or only migration code that references the legacy file name as a string).

---

## Phase 6: Docs + skill final sweep + E2E updates

**Goal:** Update `SKILL.md`, `CLAUDE.md`, and both E2E test files to reflect the final shipped behavior.

### Task 6.1: Update `skills/trusted-agents/SKILL.md`

**Files:**
- Modify: `skills/trusted-agents/SKILL.md`

- [ ] **Step 6.1.1: Read the current SKILL.md**

Skim to understand the current layout.

- [ ] **Step 6.1.2: Rewrite the `tap connect` section**

New content:

```markdown
## tap connect <invite-url>

Accept an invite and establish a connection.

### Flags

- `(default)`: Block for up to 30 seconds waiting for the peer to respond. Exit 0 on active, exit 2 on timeout.
- `--no-wait`: Return immediately after sending the request. Prints `pending`. Exit 0. Intended for scripts.
- `--wait-seconds N`: Override the default wait. `N=0` is equivalent to `--no-wait`.

### Exit codes

- `0`: Connection is active (or `pending` when `--no-wait` was used).
- `2`: Timed out waiting for the peer to respond. The connection is recoverable — run `tap message sync` later.
- Other non-zero: Validation, network, or verification error.

### Example

```bash
tap connect https://trustedagents.link/connect?agentId=7&chain=eip155%3A8453&expires=...
# ✓ Connected to alice.eth (#7, base) in 2.1s
```
```

- [ ] **Step 6.1.3: Add the Debugging section**

```markdown
## Debugging

### tap journal list

Show all in-flight and recently completed protocol operations with their status and any last error. Use this when a connection or message seems stuck.

### tap journal show <id>

Show full details of a single journal entry, including the last error if any.
```

- [ ] **Step 6.1.4: Add the Recovery section**

```markdown
## Recovery

If anything feels stuck — a connection that didn't complete, messages that aren't getting through, a suspected divergence with a peer — the universal fix is:

> **Exchange a fresh invite and run `tap connect`.**

The handlers are fully idempotent, so re-running `tap connect` with a valid invite always repairs confused state, regardless of what local state either side is in. The three-command recovery toolkit is:

- `tap connect <invite>` — establish or repair a connection.
- `tap message sync` — drain any pending messages from XMTP and process them.
- `tap contacts remove <peer>` — cleanly disconnect from a peer; sends `connection/revoke` so the other side removes their end too.

The only unrecoverable scenario is losing local state on both sides simultaneously with no way to deliver a fresh invite out-of-band. Keep a backup of at least your `config.yaml` (the OWS wallet binding — everything else can be rebuilt from peers).
```

- [ ] **Step 6.1.5: Update `tap contacts remove` section**

Add a note that it sends `connection/revoke` to the peer before deleting locally.

- [ ] **Step 6.1.6: Update OpenClaw plugin section**

Remove any mention of connection-request approval deferral. Connection requests are auto-accepted on valid invites. Replace with the new post-success `connection-established` info notification.

- [ ] **Step 6.1.7: Commit**

```bash
git add skills/trusted-agents/SKILL.md
git -c commit.gpgsign=false commit -m "docs(skill): update tap connect flags and add Debugging + Recovery sections"
```

### Task 6.2: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 6.2.1: File layout tree**

Find the ASCII file layout in the "Non-Obvious Behavior" item 9 (or wherever it lives) and remove `pending-connects.json` and `tap-commands-outbox.json` from the tree. Verify the remaining entries still reflect reality.

- [ ] **Step 6.2.2: Non-obvious behavior item 15 (async outcomes)**

Rewrite to reflect the single-journal model. Delete the `pending-connects.json` reference. Reference only `request-journal.json`.

- [ ] **Step 6.2.3: Non-obvious behavior item 16 (OpenClaw plugin)**

Remove the "connection requests always defer for user approval via the approveConnection hook" sentence. Replace with: "Connection requests are auto-accepted on valid invites; a post-success `connection-established` notification is emitted via `emitEvent`."

- [ ] **Step 6.2.4: "If You Change X" sections**

Remove outbox and pending-connects references. Audit the "Adding/changing/removing a CLI command" section to add `tap journal list` / `tap journal show` to the documented list.

- [ ] **Step 6.2.5: "Core Abstractions To Preserve" — `NotificationAdapter`**

Remove any mention of `approveConnection`. Keep `approveTransfer`.

- [ ] **Step 6.2.6: Commit**

```bash
git add CLAUDE.md
git -c commit.gpgsign=false commit -m "docs: update CLAUDE.md for single-journal state model"
```

### Task 6.3: E2E tests — update mock + live scenarios

**Files:**
- Modify: `packages/cli/test/e2e/scenarios.ts`
- Modify: `packages/cli/test/e2e/e2e-mock.test.ts`
- Modify: `packages/cli/test/e2e/e2e-live.test.ts`

- [ ] **Step 6.3.1: Update the existing invite+connect scenario**

Add assertions for the `connecting` → `active` transition. Assert exit code 0. Assert that `pending-connects.json` is NOT written to disk.

- [ ] **Step 6.3.2: Add `--no-wait` scenario**

```ts
{
  name: "connect --no-wait returns pending; sync finishes it",
  steps: async ({ alice, bob }) => {
    const invite = await alice.run("invite", "create");
    await bob.run("connect", invite.url, "--no-wait");
    expect(await bob.getContact("alice")).toMatchObject({ status: "connecting" });
    // Alice processes
    await alice.run("message", "sync");
    // Bob finishes
    await bob.run("message", "sync");
    expect(await bob.getContact("alice")).toMatchObject({ status: "active" });
  },
},
```

- [ ] **Step 6.3.3: Add the wipe-and-recover scenario**

```ts
{
  name: "reconnect after one side wipes its local state",
  steps: async ({ alice, bob }) => {
    // Establish
    const invite1 = await alice.run("invite", "create");
    await bob.run("connect", invite1.url);
    expect(await bob.getContact("alice")).toMatchObject({ status: "active" });

    // Alice wipes
    await alice.wipeState(); // rm contacts.json request-journal.json

    // Recover
    const invite2 = await alice.run("invite", "create");
    await bob.run("connect", invite2.url);
    expect(await bob.getContact("alice")).toMatchObject({ status: "active" });
    expect(await alice.getContact("bob")).toMatchObject({ status: "active" });
  },
},
```

- [ ] **Step 6.3.4: Run both e2e suites**

Run mock: `bun run test -- packages/cli/test/e2e/e2e-mock.test.ts`
Live is gated by env — skip unless credentials are available.
Expected: mock passes.

- [ ] **Step 6.3.5: Commit**

```bash
git add packages/cli/test/e2e/
git -c commit.gpgsign=false commit -m "test(e2e): add no-wait and wipe-and-recover scenarios"
```

### Task 6.4: Final verification

- [ ] **Step 6.4.1: Full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: pass.

- [ ] **Step 6.4.2: Final sanity greps**

```bash
grep -rn "pending-connects\|FilePendingConnectStore\|CONNECT_RECEIPT_TIMEOUT_MS\|approveConnection\|FileTapCommandOutbox\|acked" packages/ | grep -v "\.md:" | grep -v "migration" || echo "clean"
```

Expected: `clean` or only migration code that references the legacy names as strings.

- [ ] **Step 6.4.3: Ready the PR**

```bash
git log --oneline origin/main..HEAD
```

Expected: ~15-20 commits in topological order matching the phase structure.

Do not open a PR — hand off to the user for final review.

---

## Post-implementation checklist

Verify before asking the user to merge:

- [ ] `bun run lint && bun run typecheck && bun run test` all green.
- [ ] `pending-connects.json`, `tap-commands-outbox.json`, and `acked` status are gone from the codebase (grep confirms).
- [ ] `skills/trusted-agents/SKILL.md` reflects the new `tap connect` flags, Debugging section, and Recovery section.
- [ ] `CLAUDE.md` file layout tree no longer lists removed files.
- [ ] `tap connect` with a valid invite blocks for up to 30 seconds and returns `active` on the happy path (manual smoke test against a local two-agent setup).
- [ ] Running `tap connect` twice on the same invite produces exactly one wire exchange (verify via `tap journal list`).
- [ ] Wipe-and-reconnect recovery works end-to-end in the mock E2E.
- [ ] At least one live E2E scenario has been run against mainnet XMTP (if credentials are available).
