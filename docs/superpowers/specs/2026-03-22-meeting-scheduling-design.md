# Meeting Scheduling via TAP

**Date:** 2026-03-22
**Status:** Draft
**Branch:** meeting-scheduling

## Overview

Cross-agent meeting scheduling using TAP's existing `action/request` + `action/result` protocol. Agents negotiate meeting times autonomously, with human approval required for final acceptance. Calendar data stays local — only availability windows and proposals are shared over the wire.

## Motivation

AI scheduling is a $2B+ market growing 30%+ YoY, but cross-user scheduling between personal agents is unsolved. TAP's trust model is a natural fit — you only coordinate with people you actually know (active contacts with grants).

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Intelligence layer | Protocol defines rails, agents bring brains | Keeps protocol minimal, agents add strategy |
| Negotiation rounds | Unlimited, agents decide when to stop | YAGNI — constraints can be added later via grants |
| Time proposals | Multiple ranked slots per message | Mirrors human scheduling, minimizes round trips |
| Timezone handling | UTC on wire + originator timezone metadata | Unambiguous engineering + friendly UX |
| Calendar provider | Read + Write interface, optional | Degrades gracefully for agents without calendar access |
| No provider UX | Agent offers to set up, or human responds manually | Nudges toward full experience without blocking |
| Final acceptance | Always human-approved, even with grants | Scheduling is high-stakes — can't refund someone's time |
| Grant purpose | Authorizes auto-negotiation, not auto-acceptance | Agent handles back-and-forth, human confirms the result |
| v1 calendar | Google Calendar via `gws` CLI only | Extensible interface, CLI adapter is fastest path |
| Architecture | Moderate core + provider injection | Same proven pattern as transfers |

## Protocol — Wire Format & Negotiation

### Scope

All scheduling messages use scope `scheduling/request` (sub-scope of the already-declared `scheduling`).

### Message Types

Every scheduling message is an `action/request` or `action/result` with a `type` field in the data payload:

| Type | Direction | Wire Method | Purpose |
|------|-----------|-------------|---------|
| `scheduling/propose` | Initiator → Responder | `action/request` | Propose a meeting with ranked time slots |
| `scheduling/counter` | Either → Either | `action/request` | Counter-propose with different slots |
| `scheduling/accept` | Either → Either | `action/result` | Accept a specific slot from the last proposal |
| `scheduling/reject` | Either → Either | `action/result` | Decline the entire scheduling request |
| `scheduling/cancel` | Either → Either | `action/result` | Cancel a previously accepted meeting |

- `propose` and `counter` use `action/request` (they expect a response)
- `accept`, `reject`, and `cancel` use `action/result` (they're terminal or informational)

### Negotiation State Machine

```
propose → { accept, reject, counter }
counter → { accept, reject, counter }
accept  → done (terminal)
reject  → done (terminal)
```

No protocol-level round limits. Agents decide when to give up and send `reject`.

### Proposal Payload

```typescript
interface SchedulingProposal {
  type: "scheduling/propose" | "scheduling/counter";
  schedulingId: string;       // Stable ID across the entire negotiation
  title: string;              // "Dinner with Bob"
  duration: number;           // Minutes
  slots: TimeSlot[];          // Ordered by preference (first = most preferred)
  location?: string;          // Optional venue/link
  note?: string;              // Freeform context
  originTimezone: string;     // IANA timezone of the proposer
}

interface TimeSlot {
  start: string;  // UTC ISO 8601
  end: string;    // UTC ISO 8601
}
```

### Accept Payload

```typescript
interface SchedulingAccept {
  type: "scheduling/accept";
  schedulingId: string;
  acceptedSlot: TimeSlot;     // The chosen slot from the proposal
  note?: string;
}
```

### Reject / Cancel Payload

```typescript
interface SchedulingReject {
  type: "scheduling/reject" | "scheduling/cancel";
  schedulingId: string;
  reason?: string;
}
```

### Key Design Decisions

- **`schedulingId`** ties the entire negotiation together across multiple `action/request` / `action/result` messages — similar to how `actionId` tracks individual request/response pairs, but at the conversation level.
- **Counters are just new proposals** — same payload shape as `propose`, just different `type`. The agent can include entirely new slots or overlap with previous ones.
- **Cancel exists** because accepted meetings may need to be un-accepted. It's informational — the receiving agent updates their calendar accordingly.

## Calendar Provider Interface

Lives in `packages/core/src/scheduling/`. Follows the same dependency injection pattern as `TransportProvider` and `IAgentResolver`.

### Interface

```typescript
interface ICalendarProvider {
  /** Get busy/free windows within a time range */
  getAvailability(
    timeRange: { start: string; end: string },  // UTC ISO 8601
    options?: { timezone?: string }
  ): Promise<AvailabilityWindow[]>;

  /** Create a calendar event, return a provider-specific event ID */
  createEvent(event: CalendarEvent): Promise<{ eventId: string }>;

  /** Cancel/delete a previously created event */
  cancelEvent(eventId: string): Promise<void>;
}

interface AvailabilityWindow {
  start: string;   // UTC ISO 8601
  end: string;     // UTC ISO 8601
  status: "free" | "busy";
}

interface CalendarEvent {
  title: string;
  start: string;       // UTC ISO 8601
  end: string;         // UTC ISO 8601
  location?: string;
  description?: string;
  timezone?: string;    // IANA, for display in the calendar
}
```

### Interface Size Rationale

- **No `suggestSlots`** — the agent picks times, not the provider.
- **No `updateEvent`** — v1 only needs create and cancel. Rescheduling is cancel + create.
- **No recurring event support** — out of scope for v1. Can be added later without breaking the interface.
- **`getAvailability` returns raw windows, not suggested slots** — the agent interprets availability and decides what to propose.

### Provider Injection

The `ICalendarProvider` is optional. The host (CLI context, OpenClaw plugin, SDK orchestrator) injects it when building the `SchedulingHandler`:

```typescript
const calendarProvider = new GoogleCalendarCliProvider();
const schedulingHandler = new SchedulingHandler({ calendarProvider, trustStore, journal });
```

### Graceful Degradation (No Provider Configured)

When no calendar provider is configured:

1. Agent receives `scheduling/propose`
2. Proposal is surfaced to the human normally
3. Agent also prompts: "You don't have a calendar provider configured. Want me to set up Google Calendar now, or respond to this request manually?"
4. If the human says yes to setup, the agent walks through `gws auth login`, verifies, and writes config. It can then check availability for the current proposal immediately.
5. If the human responds manually, the negotiation proceeds — the other side still creates calendar events on their end.

Scheduling is asymmetric: even if only one side has a calendar provider, the feature is still valuable.

## Scheduling Handler & Grant Evaluation

Lives in `packages/core/src/scheduling/handler.ts`. Mirrors the `decideTransfer` pattern.

### SchedulingHandler

```typescript
class SchedulingHandler {
  constructor(options: {
    calendarProvider?: ICalendarProvider;  // Optional — degrades gracefully
    trustStore: ITrustStore;
    journal: IRequestJournal;
    hooks: SchedulingHooks;
  })
}
```

### Decision Flow

```
Inbound scheduling/propose or scheduling/counter
  → Is sender a known, active contact? (trust store check)
    → No: reject
  → Does sender have an active grant with scope "scheduling/request"?
    → No grant + no approveScheduling hook: defer for manual decision
    → No grant + hook registered: call hook (returns true/false/null)
    → Grant exists: evaluate constraints, then auto-negotiate
  → Calendar provider available?
    → Yes: getAvailability() → find overlapping free slots
           → If overlaps found: surface best match to human for approval
           → If no overlaps: auto-counter with own available slots
    → No: surface proposal to agent/human for manual decision
  → Human confirms?
    → Yes: send scheduling/accept, createEvent()
    → No: agent counters or rejects
```

**Grants authorize auto-negotiation, not auto-acceptance.** The agent handles the back-and-forth autonomously (checking calendars, finding overlaps, counter-proposing), but always comes back to the human for the final confirmation.

### Grant Constraints for Scheduling

```typescript
// Example grant Alice publishes to Bob
{
  grantId: "bob-can-schedule",
  scope: "scheduling/request",
  constraints: {
    maxDurationMinutes: 120,
    allowedDays: ["mon", "tue", "wed", "thu", "fri"],
    allowedTimeRange: {
      start: "09:00",
      end: "18:00"
    },
    timezone: "America/New_York"
  },
  status: "active"
}
```

Constraint evaluation happens **before** checking the calendar — if proposed slots violate grant constraints (e.g., Saturday dinner but grant only allows weekdays), the request is rejected without hitting the calendar.

### Hooks

```typescript
interface SchedulingHooks {
  /** Called when no grant covers the request. Return true/false/null (defer). */
  approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
  /** Called when agents converge on a slot. Human must confirm. */
  confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
  /** Called after a meeting is accepted — for side effects like notifications */
  onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
  /** Standard logging/event hooks */
  log?: (level: string, message: string) => void;
  emitEvent?: (payload: unknown) => void;
}
```

### What the Handler Does NOT Own

- **Which slots to propose** — that's the agent's job
- **When to stop negotiating** — agent decides when to `reject` instead of `counter`
- **Calendar setup** — host responsibility

## Google Calendar CLI Adapter (v1)

Lives in `packages/cli/src/lib/calendar/google-calendar.ts`. First concrete `ICalendarProvider` implementation.

### Implementation

- **`getAvailability()`**: `gws calendar events list --params '{"calendarId":"primary","timeMin":"...","timeMax":"..."}'` → parse JSON → invert to free/busy windows
- **`createEvent()`**: `gws calendar +insert --summary "..." --start "..."` → extract `eventId` from response
- **`cancelEvent()`**: `gws calendar events delete --params '{"calendarId":"primary","eventId":"..."}'`

### Authentication

Follows `gws` credential precedence (no TAP-managed Google auth):

1. `GOOGLE_WORKSPACE_CLI_TOKEN` (pre-obtained)
2. `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` (headless/CI export)
3. Encrypted keyring credentials from `gws auth login`
4. Plaintext `~/.config/gws/credentials.json`

### Setup Flow (`tap calendar setup --provider google`)

1. Check if `gws` CLI is installed (`which gws`)
2. If not installed: offer to install via npm/brew, or print instructions
3. If installed: check if authenticated (`gws calendar +agenda` test call)
4. If not authenticated: run `gws auth login -s calendar` interactively
5. Verify: fetch one event to confirm access
6. Write `calendar.provider: google` to `<dataDir>/config.yaml`

## CLI Commands

### `tap message request-meeting <peer>`

Initiate scheduling with a connected peer.

```
tap message request-meeting bob \
  --title "Dinner" \
  --duration 90 \
  --preferred "2026-03-28T19:00:00Z" \
  --note "That Italian place?"
```

Behavior:
1. Checks local calendar (if provider configured) for free slots around the preferred time
2. Builds a `scheduling/propose` with ranked slots
3. Sends via `action/request`
4. Returns `schedulingId` + receipt

If `--preferred` is omitted, the agent looks at the next few days and proposes the best available slots.

### `tap message respond-meeting <schedulingId>`

Respond to a scheduling proposal.

```
tap message respond-meeting sch_abc123 --accept
tap message respond-meeting sch_abc123 --reject --reason "Busy that week"
tap message respond-meeting sch_abc123 --counter --preferred "2026-03-29T18:00:00Z"
```

This is the human confirmation step. When the agent has negotiated down to a slot, the human runs `--accept` to finalize.

### `tap message cancel-meeting <schedulingId>`

Cancel a previously accepted meeting.

```
tap message cancel-meeting sch_abc123 --reason "Something came up"
```

Sends `scheduling/cancel` and deletes the local calendar event.

### `tap calendar setup`

Configure a calendar provider.

```
tap calendar setup --provider google
```

Interactive setup or agent-driven setup (the agent can run this flow itself when prompted).

### `tap calendar check`

Verify calendar access.

```
tap calendar check
# Output: ✓ Google Calendar connected (alice@gmail.com), 3 upcoming events
```

## OpenClaw Plugin Changes

### New `tap_gateway` Tool Actions

| Action | Purpose |
|--------|---------|
| `request_meeting` | Initiate scheduling with a connected peer |
| `respond_meeting` | Accept/reject/counter a scheduling proposal |
| `cancel_meeting` | Cancel an accepted meeting |
| `calendar_setup` | Configure calendar provider interactively |

### Notification Types

| Type | Level | Trigger |
|------|-------|---------|
| `SCHEDULING_PROPOSE` | escalation | Inbound proposal requiring response |
| `SCHEDULING_COUNTER` | escalation | Inbound counter-proposal |
| `SCHEDULING_ACCEPTED` | escalation | Meeting confirmed by peer |
| `SCHEDULING_REJECTED` | summary | Peer rejected the scheduling request |
| `SCHEDULING_CANCELLED` | escalation | Peer cancelled an accepted meeting |

All scheduling notifications that require action are escalated (not info-level) since they require human confirmation.

## User Workflow Example

Alice (NYC, calendar configured) schedules dinner with Bob (LA, calendar configured):

```
Alice: "Schedule dinner with Bob this Saturday"

Alice's agent:
  → Checks Alice's calendar → free at 7pm, 7:30pm, 8pm ET
  → Sends scheduling/propose to Bob's agent:
    { type: "scheduling/propose", schedulingId: "sch_abc123",
      title: "Dinner", duration: 90, originTimezone: "America/New_York",
      slots: [7pm, 7:30pm, 8pm] (UTC) }

Bob's agent:
  → Grant check passes
  → Checks Bob's calendar → free at 5pm PT (8pm ET) only
  → Auto-counters with 8pm ET slot

Alice's agent:
  → 8pm works on Alice's calendar
  → Surfaces to Alice: "Bob is free Saturday 8pm ET. Confirm?"

Alice: "yes"
  → Sends scheduling/accept { acceptedSlot: 8pm ET }
  → Creates "Dinner with Bob" on Alice's Google Calendar

Bob's agent:
  → Receives accept
  → Surfaces to Bob: "Dinner with Alice confirmed Saturday 5pm PT. Add to calendar?"

Bob: "yes"
  → Creates "Dinner with Alice" on Bob's Google Calendar
```

## Package Changes Summary

### Core (`packages/core/`)

**New files:**
```
src/scheduling/
├── types.ts              # SchedulingProposal, TimeSlot, SchedulingAccept, etc.
├── calendar-provider.ts  # ICalendarProvider interface + AvailabilityWindow, CalendarEvent
├── handler.ts            # SchedulingHandler — decision logic, grant evaluation
└── index.ts              # Re-exports
```

**Modified files:**
- `runtime/service.ts`: Route `scheduling/request` scope to `SchedulingHandler`, add `approveScheduling` + `confirmMeeting` + `onMeetingConfirmed` hooks
- No changes to: protocol/methods.ts, permissions/types.ts, transport, trust store, conversation logger, request journal

### CLI (`packages/cli/`)

**New files:**
```
src/lib/calendar/
├── google-calendar.ts       # GoogleCalendarCliProvider implements ICalendarProvider
└── setup.ts                 # Interactive setup flow for gws auth

src/commands/
├── message-request-meeting.ts
├── message-respond-meeting.ts
├── message-cancel-meeting.ts
├── calendar-setup.ts
└── calendar-check.ts
```

**Modified files:**
- `lib/context.ts`: Load calendar config, instantiate provider, inject into SchedulingHandler
- `commands/index.ts`: Register new commands
- `lib/tap-service.ts`: Wire `approveScheduling` and `confirmMeeting` hooks

### OpenClaw Plugin (`packages/openclaw-plugin/`)

**Modified files:**
- `src/tool.ts`: Add `request_meeting`, `respond_meeting`, `cancel_meeting`, `calendar_setup` actions
- `src/plugin.ts`: Instantiate calendar provider if configured, inject into SchedulingHandler, add scheduling notification types

### SDK (`packages/sdk/`)

**Modified files:**
- `src/orchestrator.ts`: Accept optional `calendarProvider`, pass to SchedulingHandler
- Re-export scheduling types from core

### Skills

- `packages/sdk/skills/trusted-agents/SKILL.md`: Document new commands, scheduling grant format, negotiation flow. OpenClaw section gets scheduling tool actions.

## Testing Strategy

### Unit Tests (`packages/core/test/scheduling/`)

- **`types.test.ts`** — Payload validation: valid proposals, missing fields, invalid slots (end before start), empty slot arrays
- **`handler.test.ts`** — Decision logic:
  - Grant exists + slots within constraints → routes to calendar check
  - Grant exists + slots violate constraints → reject without calendar hit
  - No grant + hook returns true/false/null → approve/reject/defer
  - No calendar provider → defer to human
  - Calendar provider: overlapping slots → surfaces match for human approval
  - Calendar provider: no overlap → auto-counter with available slots
- **`google-calendar.test.ts`** — CLI adapter with mocked `gws` subprocess: parse events, build availability, create/cancel events, handle `gws` not installed

### E2E Test Update (`packages/cli/test/e2e-two-agent-flow.test.ts`)

Add scheduling flow:
1. Agent A publishes scheduling grant to Agent B
2. Agent B sends `scheduling/propose` with 3 slots
3. Agent A: handler evaluates grant → checks mock calendar → finds overlap
4. Agent A: hook surfaces match → test simulates human approval
5. Agent A sends `scheduling/accept`
6. Agent B receives accept → verifies conversation log and journal entries

Uses `MockCalendarProvider` implementing `ICalendarProvider`.

### Not Tested in v1

- Live `gws` CLI integration (requires real Google auth — manual smoke test)
- Multi-round counter-proposal chains beyond one counter (unit test covers one; longer chains are repetition)
- OpenClaw plugin scheduling wiring (covered by unit tests on handler; plugin pattern is identical to transfers)

## Out of Scope for v1

- **Recurring meetings** — no repeat semantics
- **Multi-party scheduling** — 1:1 only
- **Calendar providers beyond Google** — interface supports it, only `gws` adapter ships
- **Venue/restaurant booking** — `location` is freeform text
- **Calendar sync/watch** — no real-time change detection
- **Meeting reminders** — left to the calendar app
- **OAuth-based Google Calendar API** — CLI adapter only
