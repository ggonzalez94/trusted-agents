import { describe, expect, it } from "vitest";
import {
	buildConnectionAccept,
	buildConnectionReject,
	buildConnectionRequest,
} from "../../../src/connection/handshake.js";
import type {
	ConnectionAcceptParams,
	ConnectionRejectParams,
	ConnectionRequestParams,
} from "../../../src/protocol/types.js";

describe("buildConnectionRequest", () => {
	it("should build a valid JSON-RPC connection/request message", () => {
		const params: ConnectionRequestParams = {
			from: { agentId: 1, chain: "eip155:1" },
			to: { agentId: 2, chain: "eip155:1" },
			proposedScope: ["general-chat", "scheduling"],
			nonce: "test-nonce",
			timestamp: "2025-01-01T00:00:00.000Z",
		};

		const msg = buildConnectionRequest(params);

		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("connection/request");
		expect(msg.id).toBeDefined();
		expect(msg.params).toEqual(params);
	});
});

describe("buildConnectionAccept", () => {
	it("should build a valid JSON-RPC connection/accept message", () => {
		const params: ConnectionAcceptParams = {
			connectionId: "conn-001",
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			acceptedScope: ["general-chat"],
			requestNonce: "nonce-001",
			timestamp: "2025-01-01T00:01:00.000Z",
		};

		const msg = buildConnectionAccept(params);

		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("connection/accept");
		expect(msg.id).toBeDefined();
		expect(msg.params).toEqual(params);
	});
});

describe("buildConnectionReject", () => {
	it("should build a valid JSON-RPC connection/reject message", () => {
		const params: ConnectionRejectParams = {
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			reason: "Not interested",
			nonce: "test-nonce",
			timestamp: "2025-01-01T00:01:00.000Z",
		};

		const msg = buildConnectionReject(params);

		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("connection/reject");
		expect(msg.id).toBeDefined();
		expect(msg.params).toEqual(params);
	});

	it("should work without a reason", () => {
		const params: ConnectionRejectParams = {
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			nonce: "test-nonce",
			timestamp: "2025-01-01T00:01:00.000Z",
		};

		const msg = buildConnectionReject(params);

		expect(msg.method).toBe("connection/reject");
		expect((msg.params as ConnectionRejectParams).reason).toBeUndefined();
	});
});
