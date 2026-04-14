import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingActionCards, deriveKind } from "../../components/chat/PendingActionCards.js";
import type { PendingItem } from "../../lib/types.js";

afterEach(() => {
	cleanup();
});

function makePending(overrides: Partial<PendingItem> = {}): PendingItem {
	return {
		requestId: "req-1",
		method: "action/request",
		peerAgentId: 42,
		peerChain: "eip155:8453",
		direction: "inbound",
		// Real /api/pending payloads carry "request" | "result" here — NOT the
		// transfer/scheduling/grant semantic kind. F2.1 was the UI crashing
		// because it blindly cast this string to ActionKind.
		kind: "request",
		status: "pending",
		...overrides,
	};
}

async function noop(_id: string): Promise<void> {
	// intentionally empty
}

describe("deriveKind", () => {
	it("maps details.type=transfer to 'transfer'", () => {
		expect(
			deriveKind({
				details: {
					type: "transfer",
					peerName: "Alice",
					peerChain: "eip155:8453",
					amount: "1",
					currency: "USDC",
					chain: "eip155:8453",
				},
			}),
		).toBe("transfer");
	});

	it("maps details.type=scheduling to 'scheduling'", () => {
		expect(
			deriveKind({
				details: {
					type: "scheduling",
					peerName: "Alice",
					peerChain: "eip155:8453",
					schedulingId: "sched-1",
					title: "Sync",
					duration: 30,
					slots: [],
					originTimezone: "UTC",
					activeGrantSummary: [],
					ledgerPath: "/tmp/ledger.json",
				},
			}),
		).toBe("scheduling");
	});

	it("falls back to 'grant' for missing details", () => {
		expect(deriveKind({ details: undefined })).toBe("grant");
	});

	it("falls back to 'grant' for unknown details.type", () => {
		expect(
			deriveKind({
				details: { type: "future-kind" } as unknown as PendingItem["details"],
			}),
		).toBe("grant");
	});
});

describe("PendingActionCards", () => {
	it("renders a transfer card from details.type='transfer' on an item whose wire kind is 'request'", () => {
		const item = makePending({
			kind: "request", // wire direction, not semantic
			details: {
				type: "transfer",
				peerName: "Alice",
				peerChain: "eip155:8453",
				amount: "1.50",
				currency: "USDC",
				chain: "eip155:8453",
				memo: "coffee",
			},
		});

		render(<PendingActionCards items={[item]} onApprove={noop} onDeny={noop} />);

		expect(screen.getByText("Transfer request")).toBeTruthy();
		expect(screen.getByText("Send 1.50 USDC")).toBeTruthy();
		expect(screen.getByText(/Alice requested a transfer/)).toBeTruthy();
		// rows surface amount / chain / memo
		expect(screen.getByText("1.50 USDC")).toBeTruthy();
		expect(screen.getByText("coffee")).toBeTruthy();
	});

	it("renders a scheduling card from details.type='scheduling'", () => {
		const item = makePending({
			requestId: "req-s",
			kind: "request",
			details: {
				type: "scheduling",
				peerName: "Bob",
				peerChain: "eip155:8453",
				schedulingId: "sched-99",
				title: "Design review",
				duration: 45,
				slots: [
					{ start: "2026-04-20T15:00:00Z", end: "2026-04-20T15:45:00Z" },
					{ start: "2026-04-20T16:00:00Z", end: "2026-04-20T16:45:00Z" },
				],
				originTimezone: "UTC",
				activeGrantSummary: [],
				ledgerPath: "/tmp/ledger.json",
			},
		});

		render(<PendingActionCards items={[item]} onApprove={noop} onDeny={noop} />);

		expect(screen.getByText("Meeting proposal")).toBeTruthy();
		expect(screen.getByText("Design review")).toBeTruthy();
		expect(screen.getByText(/Bob proposed 2 time slots/)).toBeTruthy();
		expect(screen.getByText("45 min")).toBeTruthy();
	});

	it("renders a generic fallback card without crashing when details is missing", () => {
		const item = makePending({
			kind: "request",
			details: undefined,
		});

		// This is the F2.1 regression: before the fix, rendering here threw
		// because ActionCard dereferenced KIND_META[undefined].
		expect(() =>
			render(<PendingActionCards items={[item]} onApprove={noop} onDeny={noop} />),
		).not.toThrow();

		expect(screen.getByText("Action awaiting decision")).toBeTruthy();
		expect(screen.getByText(/Request req-1/)).toBeTruthy();
	});
});
