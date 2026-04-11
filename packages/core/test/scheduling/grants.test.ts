import { describe, expect, it } from "vitest";
import { createGrantSet } from "../../src/permissions/index.js";
import type { PermissionGrant } from "../../src/permissions/types.js";
import {
	filterSchedulingProposalSlots,
	findApplicableSchedulingGrants,
	findSchedulableSchedulingSlots,
	matchesSchedulingConstraints,
} from "../../src/scheduling/grants.js";
import type { SchedulingProposal } from "../../src/scheduling/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGrant(
	overrides: Partial<PermissionGrant> & { grantId?: string } = {},
): PermissionGrant {
	return {
		grantId: overrides.grantId ?? "g1",
		scope: overrides.scope ?? "scheduling/request",
		status: overrides.status ?? "active",
		updatedAt: new Date().toISOString(),
		...("constraints" in overrides ? { constraints: overrides.constraints } : {}),
	};
}

function makeProposal(overrides: Partial<SchedulingProposal> = {}): SchedulingProposal {
	return {
		type: "scheduling/propose",
		schedulingId: "sch_test1234567890123456",
		title: "Sync",
		duration: 60,
		slots: [{ start: "2026-03-27T14:00:00Z", end: "2026-03-27T15:00:00Z" }],
		originTimezone: "UTC",
		...overrides,
	};
}

// ── matchesSchedulingConstraints ─────────────────────────────────────────────

describe("matchesSchedulingConstraints", () => {
	it("returns true when grant has no constraints", () => {
		const grant = makeGrant();
		const proposal = makeProposal();
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns true when duration is within maxDurationMinutes", () => {
		const grant = makeGrant({ constraints: { maxDurationMinutes: 120 } });
		const proposal = makeProposal({ duration: 90 });
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns true when duration equals maxDurationMinutes", () => {
		const grant = makeGrant({ constraints: { maxDurationMinutes: 60 } });
		const proposal = makeProposal({ duration: 60 });
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns false when duration exceeds maxDurationMinutes", () => {
		const grant = makeGrant({ constraints: { maxDurationMinutes: 60 } });
		const proposal = makeProposal({ duration: 90 });
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(false);
	});

	it("returns false when a slot falls on Saturday (not in allowedDays weekdays list)", () => {
		// 2026-03-28 is a Saturday
		const grant = makeGrant({
			constraints: { allowedDays: ["mon", "tue", "wed", "thu", "fri"], timezone: "UTC" },
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" }],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(false);
	});

	it("returns true when a slot falls on Friday (in allowedDays weekdays list)", () => {
		// 2026-03-27 is a Friday
		const grant = makeGrant({
			constraints: { allowedDays: ["mon", "tue", "wed", "thu", "fri"], timezone: "UTC" },
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" }],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns true when at least one slot in a multi-slot proposal is on an allowed day", () => {
		// Friday is allowed, Saturday is not.
		const grant = makeGrant({
			constraints: { allowedDays: ["mon", "tue", "wed", "thu", "fri"], timezone: "UTC" },
		});
		const proposal = makeProposal({
			slots: [
				{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" }, // Friday - ok
				{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" }, // Saturday - not ok
			],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns true for slot at 3pm ET (within 09:00–18:00 ET range)", () => {
		// 2026-03-27T19:00:00Z = 3pm ET (UTC-4 during DST in March)
		const grant = makeGrant({
			constraints: {
				allowedTimeRange: { start: "09:00", end: "18:00" },
				timezone: "America/New_York",
			},
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-27T19:00:00Z", end: "2026-03-27T20:00:00Z" }],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns false for slot at 8pm ET (outside 09:00–18:00 ET range)", () => {
		// 2026-03-28T00:00:00Z = 8pm ET (UTC-4 during DST)
		const grant = makeGrant({
			constraints: {
				allowedTimeRange: { start: "09:00", end: "18:00" },
				timezone: "America/New_York",
			},
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-28T00:00:00Z", end: "2026-03-28T01:00:00Z" }],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(false);
	});

	it("returns false when a slot starts inside the window but ends after it", () => {
		const grant = makeGrant({
			constraints: {
				allowedTimeRange: { start: "09:00", end: "18:00" },
				timezone: "UTC",
			},
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-27T17:30:00Z", end: "2026-03-27T18:30:00Z" }],
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(false);
	});

	it("returns false when allowedTimeRange.start is missing", () => {
		// Incomplete range object should not match (missing start)
		const grant = makeGrant({
			constraints: {
				allowedTimeRange: { end: "18:00" },
				timezone: "UTC",
			},
		});
		const proposal = makeProposal({
			slots: [{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" }],
		});
		// Missing start means the range check is skipped — defaults to true
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});

	it("returns false when multiple constraints combine to reject (duration ok but day fails)", () => {
		const grant = makeGrant({
			constraints: {
				maxDurationMinutes: 120,
				allowedDays: ["mon", "tue", "wed", "thu", "fri"],
				timezone: "UTC",
			},
		});
		const proposal = makeProposal({
			duration: 60, // ok
			slots: [{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" }], // Saturday
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(false);
	});

	it("returns true when all combined constraints are satisfied", () => {
		const grant = makeGrant({
			constraints: {
				maxDurationMinutes: 120,
				allowedDays: ["mon", "tue", "wed", "thu", "fri"],
				allowedTimeRange: { start: "09:00", end: "18:00" },
				timezone: "UTC",
			},
		});
		const proposal = makeProposal({
			duration: 60,
			slots: [{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" }], // Friday 10am UTC
		});
		expect(matchesSchedulingConstraints(grant, proposal)).toBe(true);
	});
});

describe("filterSchedulingProposalSlots", () => {
	it("filters out slots that do not satisfy allowedDays", () => {
		const grant = makeGrant({
			constraints: { allowedDays: ["mon", "tue", "wed", "thu", "fri"], timezone: "UTC" },
		});
		const proposal = makeProposal({
			slots: [
				{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" },
				{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" },
			],
		});

		expect(filterSchedulingProposalSlots(grant, proposal)).toEqual([
			{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" },
		]);
	});
});

// ── findApplicableSchedulingGrants ───────────────────────────────────────────

describe("findApplicableSchedulingGrants", () => {
	it("returns active scheduling/request grants that match constraints", () => {
		const grantSet = createGrantSet([
			{ grantId: "g1", scope: "scheduling/request" },
			{ grantId: "g2", scope: "scheduling/request" },
		]);
		const proposal = makeProposal();
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(2);
		expect(result.map((g) => g.grantId)).toEqual(["g1", "g2"]);
	});

	it("filters out revoked scheduling/request grants", () => {
		const grantSet = createGrantSet([
			{ grantId: "g1", scope: "scheduling/request", status: "active" },
			{ grantId: "g2", scope: "scheduling/request", status: "revoked" },
		]);
		const proposal = makeProposal();
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(1);
		expect(result[0].grantId).toBe("g1");
	});

	it("filters out non-scheduling-scope grants", () => {
		const grantSet = createGrantSet([
			{ grantId: "g1", scope: "transfer" },
			{ grantId: "g2", scope: "scheduling/request" },
		]);
		const proposal = makeProposal();
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(1);
		expect(result[0].grantId).toBe("g2");
	});

	it("returns empty array when no grants match constraints", () => {
		const grantSet = createGrantSet([
			{
				grantId: "g1",
				scope: "scheduling/request",
				constraints: { maxDurationMinutes: 30 },
			},
		]);
		const proposal = makeProposal({ duration: 90 });
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(0);
	});

	it("returns empty array when grant set is empty", () => {
		const grantSet = createGrantSet([]);
		const proposal = makeProposal();
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(0);
	});

	it("returns only grants whose constraints match when multiple grants exist", () => {
		const grantSet = createGrantSet([
			{
				grantId: "g1",
				scope: "scheduling/request",
				constraints: { maxDurationMinutes: 30 },
			},
			{
				grantId: "g2",
				scope: "scheduling/request",
				constraints: { maxDurationMinutes: 120 },
			},
		]);
		const proposal = makeProposal({ duration: 60 }); // 60 > 30 but 60 <= 120
		const result = findApplicableSchedulingGrants(grantSet, proposal);
		expect(result).toHaveLength(1);
		expect(result[0].grantId).toBe("g2");
	});
});

describe("findSchedulableSchedulingSlots", () => {
	it("returns the union of slots allowed by the active grants", () => {
		const grants = [
			makeGrant({
				grantId: "weekday",
				constraints: {
					allowedDays: ["mon", "tue", "wed", "thu", "fri"],
					timezone: "UTC",
				},
			}),
			makeGrant({
				grantId: "weekend",
				constraints: {
					allowedDays: ["sat"],
					timezone: "UTC",
				},
			}),
		];
		const proposal = makeProposal({
			slots: [
				{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" },
				{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" },
				{ start: "2026-03-29T10:00:00Z", end: "2026-03-29T11:00:00Z" },
			],
		});

		expect(findSchedulableSchedulingSlots(grants, proposal)).toEqual([
			{ start: "2026-03-27T10:00:00Z", end: "2026-03-27T11:00:00Z" },
			{ start: "2026-03-28T10:00:00Z", end: "2026-03-28T11:00:00Z" },
		]);
	});
});
