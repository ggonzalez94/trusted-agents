import { afterEach, describe, expect, it, vi } from "vitest";

const {
	loadConfigMock,
	buildContextWithTransportMock,
	createCliTapMessagingServiceMock,
	successMock,
	errorMock,
	verboseMock,
} = vi.hoisted(() => ({
	loadConfigMock: vi.fn(async () => ({})),
	buildContextWithTransportMock: vi.fn(() => ({})),
	createCliTapMessagingServiceMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
	verboseMock: vi.fn(),
}));

vi.mock("../src/lib/config-loader.js", () => ({
	loadConfig: loadConfigMock,
}));

vi.mock("../src/lib/context.js", () => ({
	buildContextWithTransport: buildContextWithTransportMock,
}));

vi.mock("../src/lib/tap-service.js", () => ({
	createCliTapMessagingService: createCliTapMessagingServiceMock,
}));

vi.mock("../src/lib/output.js", () => ({
	success: successMock,
	error: errorMock,
	verbose: verboseMock,
}));

import { messageCancelMeetingCommand } from "../src/commands/message-cancel-meeting.js";
import { messageRespondMeetingCommand } from "../src/commands/message-respond-meeting.js";

describe("meeting CLI commands", () => {
	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
	});

	it("respond-meeting resolves inbound scheduling requests and forwards reason", async () => {
		const resolvePending = vi.fn(async () => ({ pendingRequests: [] }));
		createCliTapMessagingServiceMock.mockReturnValue({
			listPendingRequests: vi.fn(async () => [
				{
					requestId: "outbound-should-ignore",
					peerAgentId: 10,
					direction: "outbound",
					kind: "request",
					method: "action/request",
					status: "pending",
					details: { type: "scheduling", schedulingId: "sch-1" },
				},
				{
					requestId: "inbound-target",
					peerAgentId: 10,
					direction: "inbound",
					kind: "request",
					method: "action/request",
					status: "pending",
					details: { type: "scheduling", schedulingId: "sch-1" },
				},
			]),
			resolvePending,
		});

		await messageRespondMeetingCommand(
			"sch-1",
			{ reject: true, reason: "Need to decline" },
			{ plain: true },
		);

		expect(resolvePending).toHaveBeenCalledTimes(1);
		expect(resolvePending).toHaveBeenCalledWith("inbound-target", false, "Need to decline");
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("cancel-meeting cancels outbound scheduling requests and forwards reason", async () => {
		const cancelPendingSchedulingRequest = vi.fn(async () => ({ pendingRequests: [] }));
		createCliTapMessagingServiceMock.mockReturnValue({
			listPendingRequests: vi.fn(async () => [
				{
					requestId: "inbound-should-ignore",
					peerAgentId: 10,
					direction: "inbound",
					kind: "request",
					method: "action/request",
					status: "pending",
					details: { type: "scheduling", schedulingId: "sch-2" },
				},
				{
					requestId: "outbound-target",
					peerAgentId: 10,
					direction: "outbound",
					kind: "request",
					method: "action/request",
					status: "pending",
					details: { type: "scheduling", schedulingId: "sch-2" },
				},
			]),
			cancelPendingSchedulingRequest,
		});

		await messageCancelMeetingCommand("sch-2", { reason: "Conflict" }, { plain: true });

		expect(cancelPendingSchedulingRequest).toHaveBeenCalledTimes(1);
		expect(cancelPendingSchedulingRequest).toHaveBeenCalledWith("outbound-target", "Conflict");
		expect(errorMock).not.toHaveBeenCalled();
	});
});
