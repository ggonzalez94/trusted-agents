# Shared Expense Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first useful shared expense loop: log an off-chain expense, compute a shared USDC balance, create a net settlement intent, and expose it through the TAP CLI.

**Architecture:** Add a TAP expense app package for shared types, validation, split math, and grant matching. Add a small centralized expense server package with repository boundaries and a Node HTTP API. Add CLI commands that configure the server URL, resolve TAP contacts, post expenses, inspect balances/history, and create settlement intents; actual USDC execution remains agent-owned.

**Tech Stack:** TypeScript, Bun workspaces, Vitest, Node HTTP, existing TAP config/trust store helpers, existing CLI output envelope.

---

### Task 1: Expense App Primitives

**Files:**
- Create: `packages/app-expenses/package.json`
- Create: `packages/app-expenses/tsconfig.json`
- Create: `packages/app-expenses/src/types.ts`
- Create: `packages/app-expenses/src/amounts.ts`
- Create: `packages/app-expenses/src/grants.ts`
- Create: `packages/app-expenses/src/index.ts`
- Test: `packages/app-expenses/test/amounts.test.ts`
- Test: `packages/app-expenses/test/grants.test.ts`

- [x] **Step 1: Write failing amount and grant tests**
- [x] **Step 2: Run tests and verify they fail because the package does not exist**
- [x] **Step 3: Implement expense types, USDC minor-unit parsing, equal splits, group id derivation, and `expense/settle` grant matching**
- [x] **Step 4: Run package tests and verify they pass**

### Task 2: Expense Server Core

**Files:**
- Create: `packages/expense-server/package.json`
- Create: `packages/expense-server/tsconfig.json`
- Create: `packages/expense-server/src/types.ts`
- Create: `packages/expense-server/src/store.ts`
- Create: `packages/expense-server/src/ledger.ts`
- Create: `packages/expense-server/src/http.ts`
- Create: `packages/expense-server/src/bin.ts`
- Create: `packages/expense-server/src/index.ts`
- Test: `packages/expense-server/test/ledger.test.ts`
- Test: `packages/expense-server/test/http.test.ts`

- [x] **Step 1: Write failing ledger tests for create group, log expense, balance, history, and settlement intent**
- [x] **Step 2: Run tests and verify they fail because server modules do not exist**
- [x] **Step 3: Implement in-memory/file-backed repositories and ledger service**
- [x] **Step 4: Write failing HTTP tests for `/health`, group creation, expense creation, balance, history, and settlement intent**
- [x] **Step 5: Implement Node HTTP routing**
- [x] **Step 6: Run server tests and verify they pass**

### Task 3: CLI Expenses Commands

**Files:**
- Create: `packages/cli/src/lib/expenses-config.ts`
- Create: `packages/cli/src/lib/expenses-client.ts`
- Create: `packages/cli/src/commands/expenses.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/expenses.test.ts`

- [x] **Step 1: Write failing CLI tests for setup, group create, log, balance, history, and settle**
- [x] **Step 2: Run tests and verify they fail because commands are missing**
- [x] **Step 3: Implement config helpers and HTTP client**
- [x] **Step 4: Implement CLI commands and register them in `createCli()`**
- [x] **Step 5: Run CLI tests and verify they pass**

### Task 4: Workspace Wiring And Docs

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `docs/superpowers/specs/2026-04-23-shared-expense-ledger-design.md`
- Modify: `skills/trusted-agents/SKILL.md`

- [x] **Step 1: Add new packages to build/typecheck scripts**
- [x] **Step 2: Update the design spec to reflect the simplified first implementation**
- [x] **Step 3: Document the new `tap expenses` commands in the canonical TAP skill**
- [x] **Step 4: Run targeted package tests, typecheck, and lint**
