import { describe, expect, it } from "vitest";
import {
	buildConnectionRequest,
	buildConnectionResult,
} from "../../../src/connection/handshake.js";
import type {
	ConnectionRequestParams,
	ConnectionResultParams,
} from "../../../src/protocol/types.js";

describe("buildConnectionRequest", () => {
	it("should build a valid JSON-RPC connection/request message", () => {
		const params: ConnectionRequestParams = {
			from: { agentId: 1, chain: "eip155:1" },
			to: { agentId: 2, chain: "eip155:1" },
			connectionId: "conn-001",
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

describe("buildConnectionResult", () => {
	it("should build a valid accepted connection/result message", () => {
		const params: ConnectionResultParams = {
			requestId: "req-001",
			requestNonce: "nonce-001",
			connectionId: "conn-001",
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			status: "accepted",
			timestamp: "2025-01-01T00:01:00.000Z",
		};

		const msg = buildConnectionResult(params);

		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("connection/result");
		expect(msg.id).toBeDefined();
		expect(msg.params).toEqual(params);
	});

	it("should build a valid rejected connection/result message", () => {
		const params: ConnectionResultParams = {
			requestId: "req-002",
			requestNonce: "nonce-002",
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			status: "rejected",
			reason: "Not interested",
			timestamp: "2025-01-01T00:01:00.000Z",
		};

		const msg = buildConnectionResult(params);

		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("connection/result");
		expect(msg.id).toBeDefined();
		expect(msg.params).toEqual(params);
	});
});
