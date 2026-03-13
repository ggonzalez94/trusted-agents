import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileTrustStore,
	TransportError,
	buildConnectionRequest,
	generateInvite,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	ResolvedAgent,
	TransportHandlers,
	TransportProvider,
} from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeConnect } from "../../src/commands/connect.js";

function createMockResolver(agent: ResolvedAgent): IAgentResolver {
	return {
		resolve: vi.fn().mockResolvedValue(agent),
		resolveWithCache: vi.fn().mockResolvedValue(agent),
	};
}

const AGENT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`;

const mockAgent: ResolvedAgent = {
	agentId: 1,
	chain: "eip155:84532",
	ownerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	agentAddress: AGENT_ADDRESS,
	xmtpEndpoint: AGENT_ADDRESS,
	endpoint: AGENT_ADDRESS,
	capabilities: ["message/send"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "TestAgent",
		description: "A test agent",
		services: [{ name: "xmtp", endpoint: AGENT_ADDRESS }],
		trustedAgentProtocol: {
			version: "0.1.0",
			agentAddress: AGENT_ADDRESS,
			capabilities: ["message/send"],
		},
	},
	resolvedAt: new Date().toISOString(),
};

function createMockTransport(
	status: "received" | "duplicate" | "queued" = "received",
	options?: {
		onSend?: (
			handlers: TransportHandlers,
			request: { id: unknown; params?: unknown },
		) => Promise<void>;
	},
): TransportProvider & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	setHandlers: ReturnType<typeof vi.fn>;
} {
	let handlers: TransportHandlers = {};
	return {
		send: vi.fn(async (_peerId, request) => {
			await options?.onSend?.(handlers, request);
			return {
				received: true,
				requestId: String(request.id),
				status,
				receivedAt: "2026-03-06T00:00:00.000Z",
			};
		}),
		setHandlers: vi.fn((nextHandlers: TransportHandlers) => {
			handlers = nextHandlers;
		}),
		start: vi.fn(),
		stop: vi.fn(),
		isReachable: vi.fn(async () => true),
	};
}

async function readPendingConnects(tmpDir: string): Promise<Array<{ requestId: string }>> {
	const raw = JSON.parse(await readFile(join(tmpDir, "pending-connects.json"), "utf-8")) as {
		pendingConnects?: Array<{ requestId: string }>;
	};
	return raw.pendingConnects ?? [];
}

describe("executeConnect", () => {
	const inviterPrivateKey =
		"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
	const connectorPrivateKey =
		"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openclaw-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("tracks a pending outbound connect without creating a contact", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});

		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport("received");

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			transport,
		});

		expect(result.success).toBe(true);
		expect(result.peerName).toBe("TestAgent");
		expect(result.status).toBe("pending");
		expect(result.receiptStatus).toBe("received");
		expect(result.connectionId).toBeUndefined();
		expect(resolver.resolve).toHaveBeenCalledWith(1, "eip155:84532");
		expect(await new FileTrustStore(tmpDir).getContacts()).toEqual([]);
		expect(await readPendingConnects(tmpDir)).toEqual([
			expect.objectContaining({
				requestId: expect.any(String),
			}),
		]);
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.stop).toHaveBeenCalledTimes(1);
	});

	it("fails with an expired invite", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: -1,
		});

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport: createMockTransport(),
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("fails with an invalid invite URL", async () => {
		const result = await executeConnect({
			inviteUrl: "https://trustedagents.link/connect?invalid=true",
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport: createMockTransport(),
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid invite URL");
	});

	it("returns pending when the delivery receipt times out", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});

		const transport: TransportProvider = {
			send: vi.fn(async (_peerId, request) => {
				throw new TransportError(`Response timeout for message ${String(request.id)}`);
			}),
			setHandlers: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			isReachable: vi.fn(async () => true),
		};

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport,
		});

		expect(result.success).toBe(true);
		expect(result.status).toBe("pending");
		expect(result.receiptStatus).toBeUndefined();
		expect(result.connectionId).toBeUndefined();
		expect(await new FileTrustStore(tmpDir).getContacts()).toEqual([]);
		expect(await readPendingConnects(tmpDir)).toHaveLength(1);
	});

	it("rejects self-invites before writing a pending connect", async () => {
		const { url } = await generateInvite({
			agentId: 2,
			chain: "eip155:84532",
			privateKey: connectorPrivateKey,
			expirySeconds: 3600,
		});
		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport();

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			transport,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Cannot connect to your own invite");
		expect(resolver.resolve).not.toHaveBeenCalled();
		expect(await new FileTrustStore(tmpDir).getContacts()).toEqual([]);
		expect(transport.start).not.toHaveBeenCalled();
	});

	it("processes an immediate accepted connection result during the connect session", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});
		const transport = createMockTransport("received", {
			onSend: async (handlers, request) => {
				await handlers.onResult?.({
					from: 1,
					senderInboxId: "peer-inbox",
					message: {
						jsonrpc: "2.0",
						id: "connection-result-1",
						method: "connection/result",
						params: {
							requestId: String(request.id),
							from: { agentId: 1, chain: "eip155:84532" },
							status: "accepted",
							timestamp: "2026-03-11T00:00:00.000Z",
						},
					},
				});
			},
		});

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport,
		});

		expect(result.success).toBe(true);
		expect(result.status).toBe("active");
		expect(result.connectionId).toBeDefined();
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.stop).toHaveBeenCalledTimes(1);

		const contacts = await new FileTrustStore(tmpDir).getContacts();
		expect(contacts[0]?.status).toBe("active");
		expect(await readPendingConnects(tmpDir)).toEqual([]);
	});

	it("keeps lazy connect from dropping unrelated inbound requests", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});
		const { invite } = await generateInvite({
			agentId: 2,
			chain: "eip155:84532",
			privateKey: connectorPrivateKey,
			expirySeconds: 3600,
		});
		const inboundAcks: Array<{ status: "received" | "duplicate" | "queued" }> = [];
		const transport = createMockTransport("received", {
			onSend: async (handlers, request) => {
				if ((request as { method?: unknown }).method !== "connection/request") {
					return;
				}
				const ack = await handlers.onRequest?.({
					from: 1,
					senderInboxId: "peer-inbox-unrelated",
					message: buildConnectionRequest({
						from: { agentId: 1, chain: "eip155:84532" },
						invite,
						timestamp: "2026-03-11T00:00:00.000Z",
					}),
				});
				if (ack) {
					inboundAcks.push(ack);
				}
			},
		});

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport,
		});

		expect(result.success).toBe(true);
		expect(inboundAcks).toEqual([{ status: "queued" }]);
	});

	it("reports an immediate rejected connection result as a failure", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});
		const transport = createMockTransport("received", {
			onSend: async (handlers, request) => {
				await handlers.onResult?.({
					from: 1,
					senderInboxId: "peer-inbox-rejected",
					message: {
						jsonrpc: "2.0",
						id: "connection-result-rejected-1",
						method: "connection/result",
						params: {
							requestId: String(request.id),
							from: { agentId: 1, chain: "eip155:84532" },
							status: "rejected",
							reason: "no thanks",
							timestamp: "2026-03-11T00:00:00.000Z",
						},
					},
				});
			},
		});

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createMockResolver(mockAgent),
			transport,
		});

		expect(result).toEqual({
			success: false,
			error: "Connection rejected by TestAgent (#1)",
		});
		expect(await new FileTrustStore(tmpDir).getContacts()).toEqual([]);
		expect(await readPendingConnects(tmpDir)).toEqual([]);
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.stop).toHaveBeenCalledTimes(1);
	});
});
