import { describe, expect, it, vi } from "vitest";
import { createGrantSet } from "../../src/permissions/index.js";
import type { PermissionGrant } from "../../src/permissions/types.js";
import type { AvailabilityWindow, ICalendarProvider } from "../../src/scheduling/calendar-provider.js";
import type { CalendarEvent } from "../../src/scheduling/calendar-provider.js";
import type { SchedulingHooks } from "../../src/scheduling/handler.js";
import { SchedulingHandler } from "../../src/scheduling/handler.js";
import type { SchedulingProposal } from "../../src/scheduling/types.js";
import type { Contact } from "../../src/trust/types.js";

// ── Mock calendar provider ─────────────────────────────────────────────────

class MockCalendarProvider implements ICalendarProvider {
	public createdEvents: CalendarEvent[] = [];
	public cancelledIds: string[] = [];

	constructor(private availability: AvailabilityWindow[]) {}

	async getAvailability(): Promise<AvailabilityWindow[]> {
		return this.availability;
	}

	async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
		this.createdEvents.push(event);
		return { eventId: "mock-event-1" };
	}

	async cancelEvent(eventId: string): Promise<void> {
		this.cancelledIds.push(eventId);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContact(grants: PermissionGrant[]): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 42,
		peerDisplayName: "Alice",
		peerChain: "eip155:84532",
		peerOwnerAddress: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
		peerAgentAddress: "0xabcdef1234567890abcdef1234567890abcdef12" as `0x${string}`,
		status: "active" as const,
		permissions: {
			grantedByMe: createGrantSet(grants),
			grantedByPeer: createGrantSet([]),
		},
		establishedAt: new Date().toISOString(),
		lastContactAt: new Date().toISOString(),
	};
}

function makeProposal(overrides: Partial<SchedulingProposal> = {}): SchedulingProposal {
	return {
		type: "scheduling/propose",
		schedulingId: "sch_test1234567890123456",
		title: "Team Sync",
		duration: 60,
		originTimezone: "America/New_York",
		slots: [
			{ start: "2026-04-01T14:00:00Z", end: "2026-04-01T15:00:00Z" },
			{ start: "2026-04-02T14:00:00Z", end: "2026-04-02T15:00:00Z" },
		],
		...overrides,
	};
}

const schedulingGrant: PermissionGrant = {
	grantId: "g1",
	scope: "scheduling/request",
	status: "active",
	updatedAt: new Date().toISOString(),
};

// Availability that overlaps with slot 1
const overlappingAvailability: AvailabilityWindow[] = [
	{ start: "2026-04-01T13:00:00Z", end: "2026-04-01T16:00:00Z", status: "free" },
];

// Availability with free slots but no overlap with proposed slots
const nonOverlappingAvailability: AvailabilityWindow[] = [
	{ start: "2026-04-03T09:00:00Z", end: "2026-04-03T10:00:00Z", status: "free" },
	{ start: "2026-04-04T11:00:00Z", end: "2026-04-04T12:00:00Z", status: "free" },
];

// Fully busy availability
const busyAvailability: AvailabilityWindow[] = [
	{ start: "2026-04-01T00:00:00Z", end: "2026-04-05T00:00:00Z", status: "busy" },
];

// ── evaluateProposal ──────────────────────────────────────────────────────────

describe("SchedulingHandler.evaluateProposal", () => {
	it("grant exists + calendar has overlap → confirm with best slot", async () => {
		const provider = new MockCalendarProvider(overlappingAvailability);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });
		const contact = makeContact([schedulingGrant]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("confirm");
		if (decision.action === "confirm") {
			expect(decision.slot).toEqual(proposal.slots[0]);
			expect(decision.proposal).toBe(proposal);
		}
	});

	it("grant exists + calendar has no overlap but has free slots → counter", async () => {
		const provider = new MockCalendarProvider(nonOverlappingAvailability);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });
		const contact = makeContact([schedulingGrant]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("counter");
		if (decision.action === "counter") {
			expect(decision.slots).toHaveLength(2);
			expect(decision.slots[0].start).toBe("2026-04-03T09:00:00Z");
		}
	});

	it("grant exists + constraint violation (duration too long) → reject", async () => {
		const constrainedGrant: PermissionGrant = {
			grantId: "g1",
			scope: "scheduling/request",
			status: "active",
			updatedAt: new Date().toISOString(),
			constraints: { maxDurationMinutes: 30 },
		};
		const provider = new MockCalendarProvider(overlappingAvailability);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });
		const contact = makeContact([constrainedGrant]);
		const proposal = makeProposal({ duration: 90 }); // 90 > 30

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("reject");
	});

	it("no grant + no hook → reject with reason", async () => {
		const provider = new MockCalendarProvider(overlappingAvailability);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });
		const contact = makeContact([]); // no grants
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("reject");
		if (decision.action === "reject") {
			expect(decision.reason).toBe("No matching scheduling grant");
		}
	});

	it("no grant + hook returns true → proceeds to calendar, confirms", async () => {
		const provider = new MockCalendarProvider(overlappingAvailability);
		const hooks: SchedulingHooks = {
			approveScheduling: vi.fn().mockResolvedValue(true),
		};
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks });
		const contact = makeContact([]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(hooks.approveScheduling).toHaveBeenCalledOnce();
		expect(decision.action).toBe("confirm");
	});

	it("no grant + hook returns false → reject", async () => {
		const provider = new MockCalendarProvider(overlappingAvailability);
		const hooks: SchedulingHooks = {
			approveScheduling: vi.fn().mockResolvedValue(false),
		};
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks });
		const contact = makeContact([]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("reject");
		if (decision.action === "reject") {
			expect(decision.reason).toBe("Scheduling request declined");
		}
	});

	it("no grant + hook returns null → defer", async () => {
		const provider = new MockCalendarProvider(overlappingAvailability);
		const hooks: SchedulingHooks = {
			approveScheduling: vi.fn().mockResolvedValue(null),
		};
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks });
		const contact = makeContact([]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("defer");
	});

	it("grant exists + no calendar provider → defer", async () => {
		const handler = new SchedulingHandler({ hooks: {} });
		const contact = makeContact([schedulingGrant]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("defer");
	});

	it("grant + calendar + no free slots at all → reject", async () => {
		const provider = new MockCalendarProvider(busyAvailability);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });
		const contact = makeContact([schedulingGrant]);
		const proposal = makeProposal();

		const decision = await handler.evaluateProposal("req-1", contact, proposal);

		expect(decision.action).toBe("reject");
		if (decision.action === "reject") {
			expect(decision.reason).toBe("No available time slots");
		}
	});
});

// ── handleAccept ──────────────────────────────────────────────────────────────

describe("SchedulingHandler.handleAccept", () => {
	it("with calendar provider → calls createEvent and returns eventId", async () => {
		const provider = new MockCalendarProvider([]);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });

		const accept = {
			type: "scheduling/accept" as const,
			schedulingId: "sch_test1234567890123456",
			acceptedSlot: { start: "2026-04-01T14:00:00Z", end: "2026-04-01T15:00:00Z" },
		};

		const result = await handler.handleAccept(accept, "Alice", "Team Sync", "America/New_York");

		expect(result.eventId).toBe("mock-event-1");
		expect(provider.createdEvents).toHaveLength(1);
		expect(provider.createdEvents[0].title).toBe("Team Sync");
		expect(provider.createdEvents[0].start).toBe("2026-04-01T14:00:00Z");
		expect(provider.createdEvents[0].end).toBe("2026-04-01T15:00:00Z");
		expect(provider.createdEvents[0].timezone).toBe("America/New_York");
	});

	it("without calendar provider → returns empty object", async () => {
		const handler = new SchedulingHandler({ hooks: {} });

		const accept = {
			type: "scheduling/accept" as const,
			schedulingId: "sch_test1234567890123456",
			acceptedSlot: { start: "2026-04-01T14:00:00Z", end: "2026-04-01T15:00:00Z" },
		};

		const result = await handler.handleAccept(accept, "Alice", "Team Sync", "UTC");

		expect(result).toEqual({});
	});
});

// ── handleCancel ──────────────────────────────────────────────────────────────

describe("SchedulingHandler.handleCancel", () => {
	it("with calendar provider → calls cancelEvent with eventId", async () => {
		const provider = new MockCalendarProvider([]);
		const handler = new SchedulingHandler({ calendarProvider: provider, hooks: {} });

		await handler.handleCancel("evt-123");

		expect(provider.cancelledIds).toEqual(["evt-123"]);
	});

	it("without calendar provider → resolves without error", async () => {
		const handler = new SchedulingHandler({ hooks: {} });
		await expect(handler.handleCancel("evt-123")).resolves.toBeUndefined();
	});
});
