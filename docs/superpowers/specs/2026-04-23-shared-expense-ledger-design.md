# Shared Expense Ledger Design

## Problem

Issue #37 proposes a shared expense tab between agents. The core product need is not a one-off split payment. It is an ongoing financial relationship where agents can log expenses as they happen, keep a shared balance, and settle the net amount later.

The first implementation uses a centralized server we control for the expense ledger and netting logic. Expenses do not create on-chain transactions. Settlement happens later in USDC on the chain chosen by the agents.

## Decision

Build v1 as a non-custodial centralized expense ledger with agent-executed USDC settlement.

The server is authoritative for expenses, splits, balances, settlement intents, and settlement verification. It does not custody user funds and does not broadcast settlement transactions. Agents keep custody of their own USDC and execute the final net transfer from their own wallet when settlement is approved or covered by a grant.

This gives the product the UX benefit of a centralized ledger while preserving the existing TAP trust model: no per-expense gas cost, no server custody, and only one on-chain USDC transfer when a tab is settled.

## Package Shape

Add `packages/app-expenses` as the TAP-facing expense app.

It owns:
- expense action payload builders
- expense payload parsing and validation helpers
- expense grant matching helpers
- public types for expense events, splits, balances, and settlement intents
- TAP app metadata for expense-related action types

Add a centralized `packages/expense-server` service.

It owns:
- agent authentication against TAP identity signatures
- append-only expense event storage
- split and balance computation
- settlement intent creation
- settlement proof verification against chain RPC
- notifications to participating agents

Keep protocol and wallet execution logic out of the server package unless it is server-specific. TAP wire method names stay in `packages/core`. Wallet signing and USDC transfer execution stay with the agent runtime.

## TAP Actions

Use TAP action requests for peer-visible workflow events, not as the source of truth.

Initial action types:
- `expense/group.invite`
- `expense/group.accept`
- `expense/created`
- `expense/acknowledge`
- `expense/dispute`
- `expense/adjust`
- `expense/settlement.intent`
- `expense/settlement.completed`
- `expense/settlement.failed`

The central server remains the financial source of truth. TAP conversations provide user-visible history and agent notifications.

## Server Data Model

Use an append-only event model with materialized views.

Primary records:
- `expense_groups`: relationship/context, usually one group per connected peer pair in v1
- `expense_group_members`: agent ids, chains, wallet addresses, display names, roles
- `expense_events`: signed immutable events such as create, acknowledge, dispute, adjust, settlement intent created, settlement completed
- `expense_splits`: derived accounting rows per participant, stored in USDC minor units
- `balances`: materialized net balance per pair/group, rebuildable from events
- `settlement_intents`: net settlement instructions created by the server
- `settlement_proofs`: tx hash, chain, verification result, and failure reason if any

Do not edit posted financial events. Corrections create new reversal or delta events linked to the original event.

## Expense Event Shape

An expense creation event contains:
- `eventId`
- `groupId`
- `idempotencyKey`
- `creator`: TAP agent id and CAIP-2 chain
- `paidBy`: TAP agent id and CAIP-2 chain
- `amountMinor`
- `asset`: `usdc`
- `expenseCurrency`: default `USD`
- `description`
- `category`
- `occurredAt`
- `participants`
- `split`: equal, shares, percentages, or exact minor units
- optional receipt attachment metadata
- previous event link when this is an adjustment
- signature over the canonical payload

For v1, keep currency conversion out of scope. If a receipt was paid in another currency, the client must submit a USDC-denominated value.

## Settlement Intent Shape

A settlement intent contains:
- `intentId`
- `groupId`
- `debtor`
- `creditor`
- `amountMinor`
- `asset`: `usdc`
- `chain`
- `tokenAddress`
- `fromAddress`
- `toAddress`
- `reason`: threshold, schedule, or manual
- `expiresAt`
- `status`: pending, approved, submitted, completed, failed, expired, canceled
- `idempotencyKey`

The debtor agent executes the transfer. The server only verifies the result.

## Settlement Verification

The server marks settlement complete only after verifying all of:
- transaction exists on the expected chain
- transaction receipt succeeded
- transfer uses the expected USDC token contract
- sender matches the debtor execution address
- recipient matches the creditor settlement address
- amount equals the settlement intent amount
- tx hash has not already been used for another settlement
- transfer happened after the intent was created and before expiry, unless manually overridden

If verification fails, keep the settlement intent pending or failed with a clear reason. Do not mutate the balance as settled until verification succeeds.

## Grants And Approval

Add an expense settlement grant scope:

```json
{
	"scope": "expense/settle",
	"constraints": {
		"asset": "usdc",
		"chains": ["eip155:8453"],
		"maxAmount": "100",
		"threshold": "25",
		"schedule": "weekly"
	}
}
```

Grant constraint names for v1 are fixed as:
- `asset`: currently `usdc`
- `chains`: CAIP-2 chains where the grant applies
- `maxAmount`: maximum single settlement amount in decimal USDC
- `threshold`: minimum net owed amount before automatic threshold settlement
- `schedule`: `manual`, `daily`, `weekly`, or `monthly`

If a settlement intent is covered by an active grant, the debtor agent may execute automatically. If no grant covers it, the debtor sees a pending approval and can approve or deny.

Do not overload `transfer/request` grants for expense settlement. Expense settlement is a different product permission because it has recurring relationship context, server-calculated netting, and a different audit trail.

## CLI UX

Add focused commands:

```bash
tap expenses setup --server https://expenses.example.com --api-token $EXPENSE_SERVER_API_TOKEN
tap expenses group create Bob --split equal --settle-threshold 25 --chain base
tap expenses log Bob 45 "groceries" --category household
tap expenses balance Bob
tap expenses history Bob
tap expenses settle Bob
tap expenses dispute <expense-id> --reason "wrong amount"
```

The natural language agent path maps to these commands or SDK calls:

> Log $45 groceries, split with Bob.

Expected behavior:
- record the expense with the server
- notify Bob's agent
- update both agents' local conversation history
- do not transfer USDC until settlement

## Agent/Server Authentication

Agents authenticate to the server with a signed challenge using their existing TAP identity. The server verifies:
- agent id and chain
- registration ownership/address
- signature freshness
- nonce replay protection

Each expense event is also signed. Server sessions make repeated calls ergonomic, but signed events keep the ledger auditable.

One-to-one expense groups are auto-created on first log when both agents are already connected TAP contacts. `tap expenses group create` remains available for explicit configuration before the first expense. Auto-created groups default to equal splits, manual settlement, and the local agent's configured chain.

## Receipt Attachments

Receipts are optional in v1.

If included, store only metadata in the expense event:
- content hash
- MIME type
- byte size
- storage URL or object key

Use S3-compatible object storage for receipt blobs. The server issues short-lived upload URLs and stores only receipt metadata in the event. Do not put large receipts in TAP messages.

## Error Handling

Server responses should be explicit and machine-readable:
- `UNAUTHENTICATED`
- `NOT_GROUP_MEMBER`
- `DUPLICATE_IDEMPOTENCY_KEY`
- `INVALID_SPLIT`
- `UNSUPPORTED_ASSET`
- `SETTLEMENT_BELOW_THRESHOLD`
- `INSUFFICIENT_GRANT`
- `SETTLEMENT_EXPIRED`
- `TX_NOT_FOUND`
- `TX_TOKEN_MISMATCH`
- `TX_AMOUNT_MISMATCH`
- `TX_SENDER_MISMATCH`
- `TX_RECIPIENT_MISMATCH`
- `TX_ALREADY_USED`

Settlement failures should not erase or rewrite the owed balance. They only update the settlement intent/proof state.

## Testing

Unit tests:
- split math and rounding
- idempotency handling
- event signature validation
- reversal/adjustment logic
- balance rebuilding from events
- settlement intent threshold logic
- grant matching for `expense/settle`
- tx verification success and failure cases

Integration tests:
- two-agent expense logging with mocked server
- server-created settlement intent to debtor agent
- debtor agent executing a mocked USDC transfer
- server verification marking settlement complete
- duplicate tx hash rejected
- dispute/adjustment flow changes balance without mutating prior events

E2E tests:
- mocked E2E in `packages/cli/test/e2e/e2e-mock.test.ts` for expense log, balance, and settlement instruction
- live E2E is optional at first and only runs settlement on a funded test wallet when explicitly enabled

## Out Of Scope For V1

- server custody of funds
- server-broadcast transfers
- multi-currency conversion
- multi-party groups larger than two agents
- receipt OCR
- on-chain expense registry
- fiat bank settlement
- recurring subscription-like pulls

The model does not block these later, but v1 ships the smallest useful loop: log expense, show balance, settle net USDC transfer.

## Implementation Defaults

Use a TypeScript Node service for `packages/expense-server`, with a small Node HTTP API and an `ExpenseStore` repository interface. The server binary uses a file-backed store by default (`EXPENSE_SERVER_DATA_FILE`) and the tests use an in-memory store. A durable Postgres store can replace that interface later without changing the TAP app, CLI commands, or HTTP API.

HTTP defaults:
- `GET /health` is public
- all ledger routes require `Authorization: Bearer <token>` when `EXPENSE_SERVER_API_TOKEN` is configured
- binding outside loopback requires `EXPENSE_SERVER_API_TOKEN`
- CLI clients can store the token with `tap expenses setup --api-token` or read it from `TAP_EXPENSES_API_TOKEN`

Settlement defaults:
- groups default to manual settlement
- v1 supports manual, threshold, and scheduled settlement triggers
- scheduled settlement means the server creates a settlement intent on the configured interval, but the debtor agent still needs either a covering `expense/settle` grant or explicit approval before USDC moves
- automatic execution only happens on the debtor agent, never from the server
