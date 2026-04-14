import type { TapPendingRequest, TapServiceStatus } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { createPendingRoutes } from "../../../src/http/routes/pending.js";

interface FakeService {
	getStatus: ReturnType<typeof vi.fn>;
	resolvePending: ReturnType<typeof vi.fn>;
}

function makeStatus(pending: TapPendingRequest[] = []): TapServiceStatus {
	return {
		running: true,
		lock: null,
		pendingRequests: pending,
	};
}

function makePendingRequest(overrides: Partial<TapPendingRequest> = {}): TapPendingRequest {
	return {
		requestId: "req-1",
		method: "action/request",
		peerAgentId: 99,
		direction: "inbound",
		kind: "request",
		status: "pending",
		...overrides,
	};
}

function makeService(pending: TapPendingRequest[] = []): FakeService {
	return {
		getStatus: vi.fn(async () => makeStatus(pending)),
		resolvePending: vi.fn(async () => ({
			synced: true,
			processed: 0,
			pendingRequests: [],
			pendingDeliveries: [],
		})),
	};
}

describe("pending routes", () => {
	it("lists pending requests", async () => {
		const service = makeService([
			makePendingRequest({ requestId: "a" }),
			makePendingRequest({ requestId: "b" }),
		]);
		const { list } = createPendingRoutes(service as never);

		const result = (await list({}, undefined)) as TapPendingRequest[];
		expect(result.map((r) => r.requestId)).toEqual(["a", "b"]);
	});

	it("approves a pending request", async () => {
		const service = makeService([makePendingRequest({ requestId: "a" })]);
		const { approve } = createPendingRoutes(service as never);

		await approve({ id: "a" }, { note: "looks good" });
		expect(service.resolvePending).toHaveBeenCalledTimes(1);
		const call = service.resolvePending.mock.calls[0];
		expect(call[0]).toBe("a");
		expect(call[1]).toBe(true);
	});

	it("denies a pending request with a reason", async () => {
		const service = makeService([makePendingRequest({ requestId: "a" })]);
		const { deny } = createPendingRoutes(service as never);

		await deny({ id: "a" }, { reason: "policy" });
		expect(service.resolvePending).toHaveBeenCalledTimes(1);
		const call = service.resolvePending.mock.calls[0];
		expect(call[0]).toBe("a");
		expect(call[1]).toBe(false);
		expect(call[2]).toBe("policy");
	});
});
