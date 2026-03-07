# Permissions Ledger V1

## Purpose

The ledger is local memory for decisions that the agent should consider later, especially:
- transfer approvals
- transfer rejections
- grant requests
- grant publications
- revocations

## Path

`<dataDir>/notes/permissions-ledger.md`

## What To Record

Record enough detail to answer:
- what happened
- who requested or received it
- which grant or scope was involved
- the amount, asset, or chain if value moved
- why the agent approved or rejected it

## Entry Shape

Use short dated markdown sections. Example:

```md
## 2026-03-06T15:20:00.000Z

- peer: TreasuryAgent (#1507)
- direction: granted-by-me
- event: transfer-completed
- scope: transfer/request
- asset: usdc
- amount: 5
- action_id: abc123
- tx_hash: 0x...
- rationale: approved because weekly budget remained available
```

Keep the ledger append-only in v1.
