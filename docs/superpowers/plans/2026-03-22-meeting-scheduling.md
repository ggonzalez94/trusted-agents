# Meeting Scheduling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-agent meeting scheduling to TAP using action/request + action/result, with a calendar provider interface and Google Calendar CLI adapter.

**Architecture:** Scheduling is a new action type riding on existing `action/request` / `action/result` protocol methods. Core defines types, parsing, grant matching, and a `SchedulingHandler`. CLI provides Google Calendar adapter via `gws` CLI and new `tap message request-meeting` / `respond-meeting` / `cancel-meeting` commands. OpenClaw plugin wires scheduling into its notification and tool surfaces.

**Tech Stack:** TypeScript (ESM, `.js` extensions), Bun (runtime/test), `gws` CLI (Google Workspace), XMTP (transport)

**Spec:** `docs/superpowers/specs/2026-03-22-meeting-scheduling-design.md`

**Conventions:**
- ESM only; TypeScript imports use `.js` extension
- Named exports only
- Biome for lint + format
- `noUnusedLocals` and `noUnusedParameters` in tsconfig
- Atomic file writes with `tmp + rename` for persistence
- Run `bun run typecheck` and `bun run test` to verify

---

## File Structure

### New Files

```
packages/core/src/scheduling/
├── types.ts              # SchedulingProposal, SchedulingAccept, SchedulingReject, TimeSlot
├── calendar-provider.ts  # ICalendarProvider, AvailabilityWindow, CalendarEvent interfaces
├── actions.ts            # parseSchedulingActionRequest, parseSchedulingActionResponse, builders
├── grants.ts             # findApplicableSchedulingGrants, matchesSchedulingConstraints
├── handler.ts            # SchedulingHandler class — decision logic
├── index.ts              # Re-exports

packages/core/test/scheduling/
├── types.test.ts         # Payload validation
├── actions.test.ts       # Parse/build round-trip tests
├── grants.test.ts        # Constraint matching tests
├── handler.test.ts       # Decision logic tests

packages/cli/src/lib/calendar/
├── google-calendar.ts    # GoogleCalendarCliProvider implements ICalendarProvider
├── setup.ts              # Interactive gws auth setup

packages/cli/src/commands/
├── message-request-meeting.ts
├── message-respond-meeting.ts
├── message-cancel-meeting.ts
├── calendar-setup.ts
├── calendar-check.ts
```

### Modified Files

```
packages/core/src/runtime/service.ts    # Route scheduling scope, add hooks, extend pending types
packages/core/src/runtime/index.ts      # Re-export scheduling module
packages/core/src/index.ts              # Re-export scheduling module
packages/cli/src/commands/index.ts      # Register new commands
packages/cli/src/lib/context.ts         # Load calendar provider config
packages/cli/src/lib/tap-service.ts     # Wire scheduling hooks
packages/openclaw-plugin/src/tool.ts     # Add scheduling tool actions
packages/openclaw-plugin/src/plugin.ts   # Wire scheduling notifications + hooks
packages/openclaw-plugin/src/registry.ts # Add requestMeeting, respondMeeting, cancelMeeting methods
packages/sdk/src/orchestrator.ts        # Accept optional calendarProvider
packages/cli/test/e2e-two-agent-flow.test.ts  # Add scheduling flow
```

---

## Task 1: Core Scheduling Types

**Files:**
- Create: `packages/core/src/scheduling/types.ts`
- Test: `packages/core/test/scheduling/types.test.ts`

- [ ] **Step 1: Write the failing test for scheduling types**

Create `packages/core/test/scheduling/types.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
	generateSchedulingId,
	validateSchedulingProposal,
	validateSchedulingAccept,
	validateSchedulingReject,
	type SchedulingProposal,
	type SchedulingAccept,
	type SchedulingReject,
} from "../../src/scheduling/types.js";

describe("generateSchedulingId", () => {
	it("generates id with sch_ prefix and 20 alphanumeric chars", () => {
		const id = generateSchedulingId();
		expect(id).toMatch(/^sch_[a-zA-Z0-9]{20}$/);
	});

	it("generates unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateSchedulingId()));
		expect(ids.size).toBe(100);
	});
});

describe("validateSchedulingProposal", () => {
	const validProposal: SchedulingProposal = {
		type: "scheduling/propose",
		schedulingId: "sch_a1b2c3d4e5f6g7h8i9j0",
		title: "Dinner",
		duration: 90,
		slots: [
			{ start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
			{ start: "2026-03-28T23:30:00Z", end: "2026-03-29T01:00:00Z" },
		],
		originTimezone: "America/New_York",
	};

	it("accepts valid proposal", () => {
		expect(validateSchedulingProposal(validProposal)).toBe(true);
	});

	it("accepts counter type", () => {
		expect(validateSchedulingProposal({ ...validProposal, type: "scheduling/counter" })).toBe(true);
	});

	it("rejects empty slots", () => {
		expect(validateSchedulingProposal({ ...validProposal, slots: [] })).toBe(false);
	});

	it("rejects slot where end is before start", () => {
		expect(validateSchedulingProposal({
			...validProposal,
			slots: [{ start: "2026-03-29T01:00:00Z", end: "2026-03-28T23:00:00Z" }],
		})).toBe(false);
	});

	it("rejects missing title", () => {
		expect(validateSchedulingProposal({ ...validProposal, title: "" })).toBe(false);
	});

	it("rejects zero duration", () => {
		expect(validateSchedulingProposal({ ...validProposal, duration: 0 })).toBe(false);
	});

	it("rejects negative duration", () => {
		expect(validateSchedulingProposal({ ...validProposal, duration: -30 })).toBe(false);
	});

	it("rejects missing originTimezone", () => {
		expect(validateSchedulingProposal({ ...validProposal, originTimezone: "" })).toBe(false);
	});
});

describe("validateSchedulingAccept", () => {
	const validAccept: SchedulingAccept = {
		type: "scheduling/accept",
		schedulingId: "sch_a1b2c3d4e5f6g7h8i9j0",
		acceptedSlot: { start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
	};

	it("accepts valid accept", () => {
		expect(validateSchedulingAccept(validAccept)).toBe(true);
	});

	it("rejects missing schedulingId", () => {
		expect(validateSchedulingAccept({ ...validAccept, schedulingId: "" })).toBe(false);
	});
});

describe("validateSchedulingReject", () => {
	it("accepts valid reject", () => {
		expect(validateSchedulingReject({
			type: "scheduling/reject",
			schedulingId: "sch_a1b2c3d4e5f6g7h8i9j0",
		})).toBe(true);
	});

	it("accepts valid cancel", () => {
		expect(validateSchedulingReject({
			type: "scheduling/cancel",
			schedulingId: "sch_a1b2c3d4e5f6g7h8i9j0",
		})).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/scheduling/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement types**

Create `packages/core/src/scheduling/types.ts`:

```typescript
import { generateNonce } from "../common/index.js";

export interface TimeSlot {
	start: string;
	end: string;
}

export interface SchedulingProposal {
	type: "scheduling/propose" | "scheduling/counter";
	schedulingId: string;
	title: string;
	duration: number;
	slots: TimeSlot[];
	location?: string;
	note?: string;
	originTimezone: string;
}

export interface SchedulingAccept {
	type: "scheduling/accept";
	schedulingId: string;
	acceptedSlot: TimeSlot;
	note?: string;
}

export interface SchedulingReject {
	type: "scheduling/reject" | "scheduling/cancel";
	schedulingId: string;
	reason?: string;
}

export type SchedulingPayload = SchedulingProposal | SchedulingAccept | SchedulingReject;

export function generateSchedulingId(): string {
	return `sch_${generateNonce().replace(/-/g, "").slice(0, 20)}`;
}

export function validateTimeSlot(slot: TimeSlot): boolean {
	if (typeof slot.start !== "string" || typeof slot.end !== "string") return false;
	return new Date(slot.start).getTime() < new Date(slot.end).getTime();
}

export function validateSchedulingProposal(proposal: SchedulingProposal): boolean {
	if (proposal.type !== "scheduling/propose" && proposal.type !== "scheduling/counter") return false;
	if (!proposal.schedulingId || proposal.schedulingId.length === 0) return false;
	if (!proposal.title || proposal.title.length === 0) return false;
	if (typeof proposal.duration !== "number" || proposal.duration <= 0) return false;
	if (!Array.isArray(proposal.slots) || proposal.slots.length === 0) return false;
	if (!proposal.originTimezone || proposal.originTimezone.length === 0) return false;
	return proposal.slots.every(validateTimeSlot);
}

export function validateSchedulingAccept(accept: SchedulingAccept): boolean {
	if (accept.type !== "scheduling/accept") return false;
	if (!accept.schedulingId || accept.schedulingId.length === 0) return false;
	return validateTimeSlot(accept.acceptedSlot);
}

export function validateSchedulingReject(reject: SchedulingReject): boolean {
	if (reject.type !== "scheduling/reject" && reject.type !== "scheduling/cancel") return false;
	return typeof reject.schedulingId === "string" && reject.schedulingId.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test test/scheduling/types.test.ts`
Expected: PASS

Note: `generateNonce` returns a UUID v4 (hex + hyphens). After stripping dashes and slicing to 20, output is hex-only (`[0-9a-f]`). The test regex `[a-zA-Z0-9]` will pass since hex is a subset, but consider using `crypto.randomBytes(15).toString('base64url').slice(0, 20)` for a richer alphabet if collision resistance matters. Update the test regex accordingly.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduling/types.ts packages/core/test/scheduling/types.test.ts
git commit -m "feat(scheduling): add core scheduling types and validation"
```

---

## Task 2: Calendar Provider Interface

**Files:**
- Create: `packages/core/src/scheduling/calendar-provider.ts`
- Create: `packages/core/src/scheduling/index.ts`

- [ ] **Step 1: Create the calendar provider interface**

Create `packages/core/src/scheduling/calendar-provider.ts`:

```typescript
export interface AvailabilityWindow {
	start: string;
	end: string;
	status: "free" | "busy";
}

export interface CalendarEvent {
	title: string;
	start: string;
	end: string;
	location?: string;
	description?: string;
	timezone?: string;
}

export interface ICalendarProvider {
	getAvailability(
		timeRange: { start: string; end: string },
		options?: { timezone?: string },
	): Promise<AvailabilityWindow[]>;

	createEvent(event: CalendarEvent): Promise<{ eventId: string }>;

	cancelEvent(eventId: string): Promise<void>;
}
```

- [ ] **Step 2: Create scheduling index re-exports**

Create `packages/core/src/scheduling/index.ts`:

```typescript
export {
	type TimeSlot,
	type SchedulingProposal,
	type SchedulingAccept,
	type SchedulingReject,
	type SchedulingPayload,
	generateSchedulingId,
	validateSchedulingProposal,
	validateSchedulingAccept,
	validateSchedulingReject,
	validateTimeSlot,
} from "./types.js";

export {
	type AvailabilityWindow,
	type CalendarEvent,
	type ICalendarProvider,
} from "./calendar-provider.js";
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/scheduling/calendar-provider.ts packages/core/src/scheduling/index.ts
git commit -m "feat(scheduling): add ICalendarProvider interface and index"
```

---

## Task 3: Scheduling Action Parsing (Request/Response)

**Files:**
- Create: `packages/core/src/scheduling/actions.ts`
- Test: `packages/core/test/scheduling/actions.test.ts`

- [ ] **Step 1: Write failing tests for scheduling action parsing**

Create `packages/core/test/scheduling/actions.test.ts`. Follow the exact pattern from `packages/core/src/runtime/actions.ts` — the `parseTransferActionRequest`/`parseTransferActionResponse` functions parse `ProtocolMessage` objects. Build test messages using the same structure.

Test cases:
- `parseSchedulingActionRequest`: valid `scheduling/propose`, valid `scheduling/counter`, returns `null` for `transfer/request` data, returns `null` for missing required fields
- `parseSchedulingActionResponse`: valid `scheduling/accept`, valid `scheduling/reject`, valid `scheduling/cancel`, returns `null` for non-scheduling responses
- `buildSchedulingProposalText`: returns human-readable summary like "Proposing: Dinner (90 min) — 3 time slots"
- `buildSchedulingAcceptText`: returns "Accepted: Dinner at 2026-03-28T23:00:00Z"
- `buildSchedulingRejectText`: returns "Declined meeting request" or "Cancelled meeting" with optional reason

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/scheduling/actions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement scheduling actions**

Create `packages/core/src/scheduling/actions.ts`. Follow `packages/core/src/runtime/actions.ts` exactly:
- Use the same `extractMessageData` pattern (import it or replicate — check if it's exported, if not replicate the extraction logic)
- `parseSchedulingActionRequest` checks `message.method === ACTION_REQUEST` and `data.type === "scheduling/propose" || "scheduling/counter"`, validates all required fields, returns typed `SchedulingProposal | null`
- `parseSchedulingActionResponse` checks `message.method === ACTION_RESULT` and `data.type` is one of `scheduling/accept`, `scheduling/reject`, `scheduling/cancel`, returns typed union or `null`
- `buildSchedulingProposalText`, `buildSchedulingAcceptText`, `buildSchedulingRejectText` — human-readable text summaries

Important: `extractMessageData` is not exported from `actions.ts`. Either replicate it in the scheduling module (it's a simple helper that walks `message.params.message.parts` to find `kind: "data"`) or refactor to export it. Replicating is simpler and avoids modifying unrelated code.

- [ ] **Step 4: Update index re-exports**

Add the new exports to `packages/core/src/scheduling/index.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && bun test test/scheduling/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/scheduling/actions.ts packages/core/test/scheduling/actions.test.ts packages/core/src/scheduling/index.ts
git commit -m "feat(scheduling): add scheduling action parsing and text builders"
```

---

## Task 4: Scheduling Grant Matching

**Files:**
- Create: `packages/core/src/scheduling/grants.ts`
- Test: `packages/core/test/scheduling/grants.test.ts`

- [ ] **Step 1: Write failing tests for grant constraint matching**

Create `packages/core/test/scheduling/grants.test.ts`:

Test cases for `matchesSchedulingConstraints(grant, proposal)`:
- No constraints → matches
- `maxDurationMinutes: 120` with 90 min proposal → matches
- `maxDurationMinutes: 60` with 90 min proposal → rejects
- `allowedDays: ["mon","tue","wed","thu","fri"]` with Saturday slot → rejects
- `allowedDays: ["mon","tue","wed","thu","fri"]` with Friday slot → matches
- `allowedTimeRange: { start: "09:00", end: "18:00" }` with `timezone: "America/New_York"` and slot at 3pm ET → matches
- Same range with slot at 8pm ET → rejects
- Multiple constraints combined

Test cases for `findApplicableSchedulingGrants(grantSet, proposal)`:
- Returns matching grants from grant set
- Filters out revoked grants
- Filters out non-scheduling scope grants
- Returns empty array when no grants match

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/scheduling/grants.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement grant matching**

Create `packages/core/src/scheduling/grants.ts`:

```typescript
import { findActiveGrantsByScope } from "../runtime/grants.js";
import type { PermissionGrant, PermissionGrantSet } from "../permissions/types.js";
import type { SchedulingProposal, TimeSlot } from "./types.js";

export function findApplicableSchedulingGrants(
	grantSet: PermissionGrantSet,
	proposal: SchedulingProposal,
): PermissionGrant[] {
	return findActiveGrantsByScope(grantSet, "scheduling/request").filter((grant) =>
		matchesSchedulingConstraints(grant, proposal),
	);
}

export function matchesSchedulingConstraints(
	grant: PermissionGrant,
	proposal: SchedulingProposal,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) return true;

	if (typeof constraints.maxDurationMinutes === "number") {
		if (proposal.duration > constraints.maxDurationMinutes) return false;
	}

	const timezone = typeof constraints.timezone === "string" ? constraints.timezone : "UTC";

	if (Array.isArray(constraints.allowedDays)) {
		const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
		for (const slot of proposal.slots) {
			const date = new Date(slot.start);
			const localDay = getLocalDayOfWeek(date, timezone);
			if (!constraints.allowedDays.includes(dayNames[localDay])) return false;
		}
	}

	if (constraints.allowedTimeRange && typeof constraints.allowedTimeRange === "object") {
		const range = constraints.allowedTimeRange as { start?: string; end?: string };
		if (typeof range.start === "string" && typeof range.end === "string") {
			for (const slot of proposal.slots) {
				if (!isSlotWithinTimeRange(slot, range.start, range.end, timezone)) return false;
			}
		}
	}

	return true;
}
```

Helper functions `getLocalDayOfWeek` and `isSlotWithinTimeRange` use `Intl.DateTimeFormat` with the IANA timezone to get localized hour/day without external dependencies.

- [ ] **Step 4: Update index re-exports**

Add `findApplicableSchedulingGrants` and `matchesSchedulingConstraints` to `packages/core/src/scheduling/index.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && bun test test/scheduling/grants.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduling/grants.ts packages/core/test/scheduling/grants.test.ts packages/core/src/scheduling/index.ts
git commit -m "feat(scheduling): add scheduling grant constraint matching"
```

---

## Task 5: SchedulingHandler (Core Decision Logic)

**Files:**
- Create: `packages/core/src/scheduling/handler.ts`
- Test: `packages/core/test/scheduling/handler.test.ts`

- [ ] **Step 1: Write failing tests for SchedulingHandler**

Create `packages/core/test/scheduling/handler.test.ts`:

Use mock implementations of `ICalendarProvider`, `ITrustStore`, and `IRequestJournal`. The handler tests should cover:

1. **Grant exists + calendar provider + overlapping slot** → handler returns `{ action: "confirm", slot: ... }` (surfaces for human approval)
2. **Grant exists + calendar provider + no overlap** → handler returns `{ action: "counter", slots: [...] }` (auto-counter with own available slots)
3. **Grant exists + constraint violation** → handler returns `{ action: "reject", reason: "..." }`
4. **No grant + no hook** → handler returns `{ action: "reject" }`
5. **No grant + hook returns true** → handler proceeds to calendar check
6. **No grant + hook returns null** → handler returns `{ action: "defer" }`
7. **No calendar provider + grant** → handler returns `{ action: "defer" }` (needs human)
8. **Accept flow**: given a `SchedulingAccept`, handler calls `calendarProvider.createEvent()` and returns confirmation

The handler should NOT send messages itself. It returns a decision that the host (service.ts, CLI, OpenClaw) acts on. This keeps it testable.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/scheduling/handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement SchedulingHandler**

Create `packages/core/src/scheduling/handler.ts`:

```typescript
import type { Contact } from "../trust/types.js";
import type { PermissionGrantSet } from "../permissions/types.js";
import type { ICalendarProvider, AvailabilityWindow } from "./calendar-provider.js";
import type { SchedulingProposal, SchedulingAccept, TimeSlot } from "./types.js";
import { findApplicableSchedulingGrants } from "./grants.js";

export interface SchedulingApprovalContext {
	requestId: string;
	contact: Contact;
	proposal: SchedulingProposal;
	activeSchedulingGrants: ReturnType<typeof findApplicableSchedulingGrants>;
}

export interface ProposedMeeting {
	schedulingId: string;
	title: string;
	slot: TimeSlot;
	peerName: string;
	peerAgentId: number;
	originTimezone: string;
}

export interface ConfirmedMeeting extends ProposedMeeting {
	eventId?: string;
}

export interface SchedulingHooks {
	approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
	confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
	onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

export type SchedulingDecision =
	| { action: "confirm"; slot: TimeSlot; proposal: SchedulingProposal }
	| { action: "counter"; slots: TimeSlot[]; proposal: SchedulingProposal }
	| { action: "reject"; reason: string }
	| { action: "defer" };

export class SchedulingHandler {
	private calendarProvider?: ICalendarProvider;
	private hooks: SchedulingHooks;

	constructor(options: {
		calendarProvider?: ICalendarProvider;
		hooks: SchedulingHooks;
	}) {
		this.calendarProvider = options.calendarProvider;
		this.hooks = options.hooks;
	}

	async evaluateProposal(
		requestId: string,
		contact: Contact,
		proposal: SchedulingProposal,
	): Promise<SchedulingDecision> {
		// 1. Check grants
		const grants = findApplicableSchedulingGrants(
			contact.permissions.grantedByMe,
			proposal,
		);

		if (grants.length === 0) {
			if (this.hooks.approveScheduling) {
				const decision = await this.hooks.approveScheduling({
					requestId, contact, proposal, activeSchedulingGrants: grants,
				});
				if (decision === false) return { action: "reject", reason: "Denied by owner" };
				if (decision === null) return { action: "defer" };
				// decision === true — proceed to calendar check
			} else {
				return { action: "reject", reason: "No matching scheduling grant" };
			}
		}

		// 2. Check calendar
		if (!this.calendarProvider) {
			return { action: "defer" };
		}

		const timeRange = getProposalTimeRange(proposal.slots);
		const availability = await this.calendarProvider.getAvailability(timeRange);
		const overlapping = findOverlappingFreeSlots(proposal.slots, availability);

		if (overlapping.length > 0) {
			return { action: "confirm", slot: overlapping[0], proposal };
		}

		// No overlap — counter with own free slots
		const freeSlots = availability
			.filter((w) => w.status === "free")
			.map((w) => ({ start: w.start, end: w.end }));

		if (freeSlots.length > 0) {
			return { action: "counter", slots: freeSlots, proposal };
		}

		return { action: "reject", reason: "No available time slots" };
	}

	async handleAccept(
		accept: SchedulingAccept,
		peerName: string,
		title: string,
		originTimezone: string,
	): Promise<{ eventId?: string }> {
		if (!this.calendarProvider) {
			return {};
		}
		const result = await this.calendarProvider.createEvent({
			title: `${title} with ${peerName}`,
			start: accept.acceptedSlot.start,
			end: accept.acceptedSlot.end,
			timezone: originTimezone,
		});
		return result;
	}

	async handleCancel(eventId: string): Promise<void> {
		if (this.calendarProvider) {
			await this.calendarProvider.cancelEvent(eventId);
		}
	}
}
```

Implement `getProposalTimeRange` (min start / max end from slots) and `findOverlappingFreeSlots` (check if any proposed slot overlaps a free window) as module-level helpers.

- [ ] **Step 4: Update index re-exports**

Add handler types and class to `packages/core/src/scheduling/index.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && bun test test/scheduling/handler.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun run test`
Expected: PASS — no regressions

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/scheduling/handler.ts packages/core/test/scheduling/handler.test.ts packages/core/src/scheduling/index.ts
git commit -m "feat(scheduling): add SchedulingHandler with grant evaluation and calendar check"
```

---

## Task 6: Integrate Scheduling into TapMessagingService

**Files:**
- Modify: `packages/core/src/runtime/service.ts`
- Modify: `packages/core/src/runtime/index.ts`
- Modify: `packages/core/src/index.ts`

This is the most delicate task — modifying the existing service. Read the file fully before making changes.

- [ ] **Step 1: Add scheduling imports and types to service.ts**

At the top of `service.ts`, add imports for scheduling types:
- Import `parseSchedulingActionRequest`, `parseSchedulingActionResponse`, scheduling text builders from `../scheduling/actions.js`
- Import `SchedulingHandler`, `SchedulingDecision`, hook types from `../scheduling/handler.js`

Add `TapPendingSchedulingDetails` interface (after `TapPendingTransferDetails`):

```typescript
export interface TapPendingSchedulingDetails {
	type: "scheduling";
	peerName: string;
	peerChain: string;
	schedulingId: string;
	title: string;
	duration: number;
	slots: Array<{ start: string; end: string }>;
	originTimezone: string;
	note?: string;
	activeGrantSummary: string[];
	ledgerPath: string;
}
```

Update the union type:
```typescript
export type TapPendingRequestDetails = TapPendingTransferDetails | TapPendingSchedulingDetails;
```

- [ ] **Step 2: Extend TapServiceHooks with scheduling hooks**

Add to `TapServiceHooks`:
```typescript
approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
```

- [ ] **Step 3: Add schedulingHandler as optional dependency**

In `TapServiceOptions`, add:
```typescript
schedulingHandler?: SchedulingHandler;
```

In the `TapMessagingService` constructor, store it:
```typescript
private schedulingHandler?: SchedulingHandler;
```

- [ ] **Step 4: Route scheduling scope in onRequest**

In the `onRequest` method, after the `transfer/request` handling block (around line 1191-1212), add a scheduling branch:

```typescript
const schedulingRequest = parseSchedulingActionRequest(envelope.message);
if (schedulingRequest) {
	await this.context.requestJournal.updateMetadata(
		String(envelope.message.id),
		serializePendingSchedulingRequestDetails(contact, schedulingRequest, this.context.config.dataDir),
	);
	this.enqueue(requestKey, async () => {
		await this.processSchedulingRequest(contact, String(envelope.message.id), schedulingRequest);
	});
	return { status: "queued" };
}
```

- [ ] **Step 5: Add processSchedulingRequest method**

Add a private method `processSchedulingRequest` that:
1. Calls `this.schedulingHandler?.evaluateProposal(requestId, contact, proposal)`
2. If no handler, logs warning and returns (request stays pending)
3. Based on `SchedulingDecision.action`:
   - `"confirm"` — call `confirmMeeting` hook, if confirmed send `scheduling/accept` via `buildOutgoingActionResult`
   - `"counter"` — send `scheduling/counter` via `buildOutgoingActionRequest`
   - `"reject"` — send `scheduling/reject` via `buildOutgoingActionResult`
   - `"defer"` — leave pending in journal

- [ ] **Step 6: Route scheduling results in handleActionResult**

In `handleActionResult`, after `parseTransferActionResponse` returns null, add:

```typescript
const schedulingResponse = parseSchedulingActionResponse(message);
if (schedulingResponse) {
	// Handle scheduling/accept, scheduling/reject, scheduling/cancel
	// Update journal, log to ledger, notify via hooks
	// If accept: call schedulingHandler.handleAccept to create calendar event
	// If cancel: call schedulingHandler.handleCancel if we have an eventId
}
```

- [ ] **Step 7: Extend resolvePending with scope-based dispatch**

In `resolvePending`, where it currently does:
```typescript
if (entry.method === ACTION_REQUEST) {
	this.decisionOverrides.transfers.set(requestId, approve);
}
```

Add scope check from metadata:
```typescript
if (entry.method === ACTION_REQUEST) {
	const isScheduling = entry.metadata?.type === "scheduling";
	if (isScheduling) {
		this.decisionOverrides.scheduling.set(requestId, approve);
	} else {
		this.decisionOverrides.transfers.set(requestId, approve);
	}
}
```

And in the resolution block:
```typescript
if (latestEntry.method === ACTION_REQUEST) {
	const isScheduling = latestEntry.metadata?.type === "scheduling";
	if (isScheduling) {
		await this.resolvePendingSchedulingRequest(latestEntry);
	} else {
		await this.resolvePendingTransferRequest(latestEntry);
	}
}
```

Add `decisionOverrides.scheduling` Map and `resolvePendingSchedulingRequest` method.

- [ ] **Step 8: Update parsePendingRequestDetails**

Add scheduling variant handling:
```typescript
if (metadata.type === "scheduling") {
	return {
		type: "scheduling",
		peerName: asString(metadata.peerName) ?? "Unknown peer",
		peerChain: asString(metadata.peerChain) ?? "unknown",
		schedulingId: asString(metadata.schedulingId) ?? "",
		title: asString(metadata.title) ?? "",
		duration: typeof metadata.duration === "number" ? metadata.duration : 0,
		slots: Array.isArray(metadata.slots) ? metadata.slots : [],
		originTimezone: asString(metadata.originTimezone) ?? "UTC",
		note: asString(metadata.note),
		activeGrantSummary: asStringArray(metadata.activeGrantSummary),
		ledgerPath: asString(metadata.ledgerPath) ?? "",
	};
}
```

- [ ] **Step 9: Add serializePendingSchedulingRequestDetails helper**

Following the pattern of the existing `serializePendingTransferRequestDetails` (search for it — it writes metadata for pending transfer requests).

- [ ] **Step 10: Update runtime and core index re-exports**

In `packages/core/src/runtime/index.ts`, add:
```typescript
export * from "../scheduling/index.js";
```

In `packages/core/src/index.ts`, add:
```typescript
export * from "./scheduling/index.js";
```

- [ ] **Step 11: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 12: Run full test suite**

Run: `bun run test`
Expected: PASS — no regressions in existing tests

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/src/runtime/index.ts packages/core/src/index.ts
git commit -m "feat(scheduling): integrate scheduling into TapMessagingService"
```

---

## Task 7: Google Calendar CLI Adapter

**Files:**
- Create: `packages/cli/src/lib/calendar/google-calendar.ts`
- Test: `packages/cli/test/calendar/google-calendar.test.ts`

- [ ] **Step 1: Write failing tests for Google Calendar adapter**

Create `packages/cli/test/calendar/google-calendar.test.ts` with mocked subprocess calls. Use `bun:test` mocking to mock `child_process.execFile` or create a wrapper function that the adapter calls (easier to mock).

Test cases:
- `getAvailability`: mocked `gws calendar events list` returns JSON events → adapter inverts to free/busy windows
- `getAvailability`: handles empty calendar (no events = all free)
- `createEvent`: mocked `gws calendar +insert` returns JSON with event id → adapter extracts
- `cancelEvent`: mocked `gws calendar events delete` succeeds → no error
- `getAvailability`: `gws` not found → throws clear error with install instructions

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test test/calendar/google-calendar.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Google Calendar adapter**

Create `packages/cli/src/lib/calendar/google-calendar.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailabilityWindow, CalendarEvent, ICalendarProvider } from "@trustedagents/core";

const execFileAsync = promisify(execFile);

export class GoogleCalendarCliProvider implements ICalendarProvider {
	async getAvailability(
		timeRange: { start: string; end: string },
		_options?: { timezone?: string },
	): Promise<AvailabilityWindow[]> {
		const params = JSON.stringify({
			calendarId: "primary",
			timeMin: timeRange.start,
			timeMax: timeRange.end,
			singleEvents: true,
			orderBy: "startTime",
		});

		const { stdout } = await this.runGws(["calendar", "events", "list", "--params", params]);
		const events = this.parseEventsOutput(stdout);
		return this.invertToBusyFree(events, timeRange);
	}

	async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
		const args = [
			"calendar", "+insert",
			"--summary", event.title,
			"--start", event.start,
		];
		// Add other fields as --params JSON if needed

		const { stdout } = await this.runGws(args);
		const parsed = JSON.parse(stdout);
		return { eventId: parsed.id ?? parsed.eventId ?? "" };
	}

	async cancelEvent(eventId: string): Promise<void> {
		const params = JSON.stringify({ calendarId: "primary", eventId });
		await this.runGws(["calendar", "events", "delete", "--params", params]);
	}

	private async runGws(args: string[]): Promise<{ stdout: string }> {
		try {
			return await execFileAsync("gws", args, { timeout: 30_000 });
		} catch (err) {
			// Check if gws is not installed
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(
					"Google Workspace CLI (gws) is not installed. Install with: npm install -g @googleworkspace/cli",
				);
			}
			throw err;
		}
	}

	// Parse gws events list JSON output into busy windows
	private parseEventsOutput(stdout: string): Array<{ start: string; end: string }> {
		// gws outputs NDJSON or JSON — parse accordingly
		// Extract start.dateTime and end.dateTime from each event
	}

	// Invert busy windows to free/busy availability
	private invertToBusyFree(
		busyEvents: Array<{ start: string; end: string }>,
		timeRange: { start: string; end: string },
	): AvailabilityWindow[] {
		// Sort events by start, fill gaps with "free" windows
	}
}
```

Implementation notes:
- `gws calendar events list` outputs JSON with `items` array, each having `start.dateTime` and `end.dateTime`
- The inversion algorithm: sort busy events by start time, create "free" windows in the gaps between them and the time range boundaries
- Handle edge cases: overlapping events, all-day events

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test test/calendar/google-calendar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/calendar/google-calendar.ts packages/cli/test/calendar/google-calendar.test.ts
git commit -m "feat(scheduling): add Google Calendar CLI adapter via gws"
```

---

## Task 8: Calendar Setup Command

**Files:**
- Create: `packages/cli/src/lib/calendar/setup.ts`
- Create: `packages/cli/src/commands/calendar-setup.ts`
- Create: `packages/cli/src/commands/calendar-check.ts`

- [ ] **Step 1: Implement calendar setup helper**

Create `packages/cli/src/lib/calendar/setup.ts`:
- `checkGwsInstalled()`: runs `which gws`, returns boolean
- `checkGwsAuthenticated()`: runs `gws calendar +agenda`, returns boolean
- `runGwsAuth()`: spawns `gws auth login -s calendar` with inherited stdio for interactive auth
- `writeCalendarConfig(dataDir, provider)`: updates `config.yaml` with `calendar.provider: google`

- [ ] **Step 2: Implement calendar-setup command**

Create `packages/cli/src/commands/calendar-setup.ts` following the existing command pattern:
- Accept `--provider` flag (default: `google`)
- Flow: check installed → check auth → run auth if needed → verify → write config
- Output: success/error in standard CLI output format

- [ ] **Step 3: Implement calendar-check command**

Create `packages/cli/src/commands/calendar-check.ts`:
- Load calendar config from `config.yaml`
- If no provider configured: output "No calendar provider configured. Run `tap calendar setup`"
- If configured: instantiate provider, call `getAvailability` for next 24h, output status

- [ ] **Step 4: Register commands**

Add to `packages/cli/src/commands/index.ts`:
- `tap calendar setup` → `calendarSetupCommand`
- `tap calendar check` → `calendarCheckCommand`

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/calendar/ packages/cli/src/commands/calendar-setup.ts packages/cli/src/commands/calendar-check.ts packages/cli/src/commands/index.ts
git commit -m "feat(scheduling): add tap calendar setup and tap calendar check commands"
```

---

## Task 9: CLI Scheduling Commands

**Files:**
- Create: `packages/cli/src/commands/message-request-meeting.ts`
- Create: `packages/cli/src/commands/message-respond-meeting.ts`
- Create: `packages/cli/src/commands/message-cancel-meeting.ts`
- Modify: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/lib/context.ts`
- Modify: `packages/cli/src/lib/tap-service.ts`

- [ ] **Step 1: Update CLI context to load calendar provider**

In `packages/cli/src/lib/context.ts`:
- Read `calendar.provider` from config
- If `"google"`, instantiate `GoogleCalendarCliProvider`
- Attach to context as `calendarProvider?: ICalendarProvider`

- [ ] **Step 2: Update tap-service.ts to wire scheduling hooks**

In `packages/cli/src/lib/tap-service.ts`:
- Add `approveScheduling` hook: prints scheduling request details, prompts y/n (same pattern as `approveTransfer`)
- Add `confirmMeeting` hook: prints proposed meeting details, prompts y/n for final acceptance
- Create `SchedulingHandler` from calendar provider and hooks, pass to `TapMessagingService`

- [ ] **Step 3: Implement message-request-meeting command**

Create `packages/cli/src/commands/message-request-meeting.ts`:
- Follow exact pattern of `message-request-funds.ts`
- Accept: `peer`, `--title`, `--duration`, `--preferred`, `--location`, `--note`
- Load context, create service
- If calendar provider available and `--preferred` given: call `getAvailability` around preferred time, rank 3-5 free slots
- If no provider or no preferred: use preferred time as single slot
- Generate `schedulingId` via `generateSchedulingId()`
- Build `SchedulingProposal` payload
- Call `service.sendSchedulingProposal(...)` (add this method to service — or use the existing `buildOutgoingActionRequest` with scope `scheduling/request`)
- Use `runOrQueueTapCommand` pattern
- Output: schedulingId, receipt, peer info

- [ ] **Step 4: Implement message-respond-meeting command**

Create `packages/cli/src/commands/message-respond-meeting.ts`:
- Accept: `schedulingId`, `--accept`, `--reject`, `--counter`, `--preferred`, `--reason`
- Look up pending request by schedulingId in journal
- If `--accept`: call `resolvePending(requestId, true)` — the confirmMeeting hook will prompt
- If `--reject`: call `resolvePending(requestId, false)`
- If `--counter`: build counter-proposal, send via action/request

- [ ] **Step 5: Implement message-cancel-meeting command**

Create `packages/cli/src/commands/message-cancel-meeting.ts`:
- Accept: `schedulingId`, `--reason`
- Look up completed scheduling request in journal by schedulingId
- Send `scheduling/cancel` via `buildOutgoingActionResult`
- If calendar provider available and eventId stored: call `cancelEvent`

- [ ] **Step 6: Register commands**

Add to `packages/cli/src/commands/index.ts`:
- `tap message request-meeting` → `messageRequestMeetingCommand`
- `tap message respond-meeting` → `messageRespondMeetingCommand`
- `tap message cancel-meeting` → `messageCancelMeetingCommand`

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 8: Run lint**

Run: `bun run lint`
Expected: PASS (fix any Biome issues)

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/message-request-meeting.ts packages/cli/src/commands/message-respond-meeting.ts packages/cli/src/commands/message-cancel-meeting.ts packages/cli/src/commands/index.ts packages/cli/src/lib/context.ts packages/cli/src/lib/tap-service.ts
git commit -m "feat(scheduling): add tap message request-meeting, respond-meeting, cancel-meeting commands"
```

---

## Task 10: OpenClaw Plugin Integration

**Files:**
- Modify: `packages/openclaw-plugin/src/tool.ts`
- Modify: `packages/openclaw-plugin/src/plugin.ts`
- Modify: `packages/openclaw-plugin/src/registry.ts` (add `requestMeeting`, `respondMeeting`, `cancelMeeting` methods)

- [ ] **Step 1: Add scheduling tool actions**

In `packages/openclaw-plugin/src/tool.ts`, add cases in the tool action switch:

```typescript
case "request_meeting":
	return await registry.requestMeeting({
		identity: params.identity,
		peer: requireString(params.peer, "peer"),
		title: requireString(params.title, "title"),
		duration: typeof params.duration === "number" ? params.duration : 60,
		preferred: optionalString(params.preferred),
		location: optionalString(params.location),
		note: optionalString(params.note),
	});

case "respond_meeting":
	return await registry.respondMeeting({
		identity: params.identity,
		schedulingId: requireString(params.schedulingId, "schedulingId"),
		action: requireString(params.action, "action"), // "accept" | "reject" | "counter"
		preferred: optionalString(params.preferred),
		reason: optionalString(params.reason),
	});

case "cancel_meeting":
	return await registry.cancelMeeting({
		identity: params.identity,
		schedulingId: requireString(params.schedulingId, "schedulingId"),
		reason: optionalString(params.reason),
	});
```

- [ ] **Step 2: Add scheduling notification classification**

In `packages/openclaw-plugin/src/plugin.ts`, where inbound events are classified, add scheduling event types:

- `scheduling/propose` → `SCHEDULING_PROPOSE` (escalation)
- `scheduling/counter` → `SCHEDULING_COUNTER` (escalation)
- `scheduling/accept` → `SCHEDULING_ACCEPTED` (escalation)
- `scheduling/reject` → `SCHEDULING_REJECTED` (summary)
- `scheduling/cancel` → `SCHEDULING_CANCELLED` (escalation)

- [ ] **Step 3: Wire scheduling hooks in plugin**

In the plugin's `TapMessagingService` hook wiring:
- `approveScheduling`: defer for operator approval (return `null`) — same pattern as `approveConnection`
- `confirmMeeting`: defer for operator confirmation (return `null`)
- `onMeetingConfirmed`: emit event for notification

- [ ] **Step 4: Add registry methods**

In the registry (wherever `requestFunds` is defined), add `requestMeeting`, `respondMeeting`, `cancelMeeting` methods that call the underlying `TapMessagingService`.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/src/tool.ts packages/openclaw-plugin/src/plugin.ts packages/openclaw-plugin/src/registry.ts
git commit -m "feat(scheduling): add scheduling tool actions and notifications to OpenClaw plugin"
```

---

## Task 11: SDK Orchestrator Update

**Files:**
- Modify: `packages/sdk/src/orchestrator.ts`

- [ ] **Step 1: Add calendarProvider to orchestrator config**

In `TrustedAgentsOrchestrator` config type, add:
```typescript
calendarProvider?: ICalendarProvider;
```

- [ ] **Step 2: Pass to SchedulingHandler**

When the orchestrator creates `TapMessagingService`, also create and pass `SchedulingHandler` with the calendar provider.

- [ ] **Step 3: Re-export scheduling types**

Ensure scheduling types are accessible through the SDK package.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/orchestrator.ts
git commit -m "feat(scheduling): add calendarProvider support to SDK orchestrator"
```

---

## Task 12: E2E Test

**Files:**
- Modify: `packages/cli/test/e2e-two-agent-flow.test.ts`

- [ ] **Step 1: Add MockCalendarProvider**

At the top of the test file (or in a test helper), create:

```typescript
class MockCalendarProvider implements ICalendarProvider {
	public createdEvents: CalendarEvent[] = [];
	public cancelledEventIds: string[] = [];
	private availability: AvailabilityWindow[];

	constructor(availability: AvailabilityWindow[]) {
		this.availability = availability;
	}

	async getAvailability(): Promise<AvailabilityWindow[]> {
		return this.availability;
	}

	async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
		this.createdEvents.push(event);
		return { eventId: `mock-event-${this.createdEvents.length}` };
	}

	async cancelEvent(eventId: string): Promise<void> {
		this.cancelledEventIds.push(eventId);
	}
}
```

- [ ] **Step 2: Add scheduling grant to the grant file**

In the test's grant setup, add a scheduling grant:
```json
{
	"grantId": "scheduling-grant",
	"scope": "scheduling/request",
	"constraints": { "maxDurationMinutes": 180 },
	"status": "active"
}
```

- [ ] **Step 3: Add scheduling flow test**

After the existing transfer flow tests, add a new test section:

1. Worker agent sends `tap message request-meeting TreasuryAgent --title "Dinner" --duration 90 --preferred "2026-03-28T23:00:00Z"`
2. Treasury agent syncs, receives proposal, evaluates against grant + mock calendar
3. The `confirmMeeting` hook simulates human approval
4. Treasury agent sends `scheduling/accept`
5. Worker agent receives accept
6. Verify: conversation logs contain scheduling messages, mock calendar has created event

- [ ] **Step 4: Run E2E test**

Run: `cd packages/cli && bun test test/e2e-two-agent-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/test/e2e-two-agent-flow.test.ts
git commit -m "test(scheduling): add scheduling flow to E2E two-agent test"
```

---

## Task 13: Skill Documentation Update

**Files:**
- Modify: `packages/sdk/skills/trusted-agents/SKILL.md`

Use the `skill-creator` skill for this task. The skill file must document:

1. **New commands:**
   - `tap message request-meeting <peer>` — all flags, examples, errors
   - `tap message respond-meeting <schedulingId>` — accept/reject/counter modes
   - `tap message cancel-meeting <schedulingId>` — cancellation with reason
   - `tap calendar setup --provider google` — setup flow
   - `tap calendar check` — verify calendar access

2. **Scheduling grant format** — example JSON, constraint fields

3. **Negotiation flow** — propose → counter → accept/reject, with examples

4. **OpenClaw plugin mode** — `tap_gateway` scheduling actions (request_meeting, respond_meeting, cancel_meeting), notification types, gated with "Skip this section if not OpenClaw"

5. **Run evals** — write simple, vague prompts that a user might naturally say:
   - "schedule a meeting with Bob"
   - "check my calendar"
   - "I need to set up dinner with Alice on Saturday"
   - "cancel my meeting with Bob"
   - "what meetings do I have pending"
   - "Bob wants to reschedule, propose some new times"

- [ ] **Step 1: Invoke the skill-creator skill**

- [ ] **Step 2: Update SKILL.md with scheduling commands**

- [ ] **Step 3: Write evals with vague, common prompts**

- [ ] **Step 4: Run evals and iterate until pass**

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/skills/trusted-agents/SKILL.md
git commit -m "docs(scheduling): update TAP skill with scheduling commands and negotiation flow"
```

---

## Task 14: Final Verification

- [ ] **Step 1: Run full lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 2: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

- [ ] **Step 4: Run E2E test specifically**

Run: `cd packages/cli && bun test test/e2e-two-agent-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Review git log for clean commit history**

Run: `git log --oneline`
Verify: each commit is focused and conventional

- [ ] **Step 6: Final commit if any cleanup needed**

Only if there are remaining uncommitted changes from cleanup.
