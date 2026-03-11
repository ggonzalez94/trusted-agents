import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInvite } from "trusted-agents-core";
import type {
	IAgentResolver,
	ResolvedAgent,
	TransportHandlers,
	TransportProvider,
} from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrustedAgentsOrchestrator } from "../src/orchestrator.js";

const INVITER_PRIVATE_KEY =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CONNECTOR_PRIVATE_KEY =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const INVITER_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;

function createResolver(agent: ResolvedAgent): IAgentResolver {
	return {
		resolve: vi.fn().mockResolvedValue(agent),
		resolveWithCache: vi.fn().mockResolvedValue(agent),
	};
}

function createTransportMock(options?: {
	onSend?: (
		handlers: TransportHandlers,
		request: { id: unknown; params?: unknown },
	) => Promise<void>;
}): TransportProvider & {
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
				status: "received" as const,
				receivedAt: "2026-03-06T00:00:00.000Z",
			};
		}),
		setHandlers: vi.fn((nextHandlers: TransportHandlers) => {
			handlers = nextHandlers;
		}),
		isReachable: vi.fn(async () => true),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
	};
}

describe("TrustedAgentsOrchestrator", () => {
	let tmpDir: string;
	let resolvedAgent: ResolvedAgent;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
		resolvedAgent = {
			agentId: 1,
			chain: "eip155:84532",
			ownerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			agentAddress: INVITER_ADDRESS,
			xmtpEndpoint: INVITER_ADDRESS,
			endpoint: undefined,
			capabilities: ["message/send"],
			registrationFile: {
				type: "eip-8004-registration-v1",
				name: "Inviter",
				description: "Test inviter",
				services: [{ name: "xmtp", endpoint: INVITER_ADDRESS }],
				trustedAgentProtocol: {
					version: "1.0",
					agentAddress: INVITER_ADDRESS,
					capabilities: ["message/send"],
				},
			},
			resolvedAt: new Date().toISOString(),
		};
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should register inbound handlers and start transport once", async () => {
		const transport = createTransportMock();
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createResolver(resolvedAgent),
			transport,
		});

		const handlers = {
			onRequest: vi.fn(async () => ({ status: "received" as const })),
		};

		await orchestrator.start({ handlers });
		await orchestrator.start({ handlers });

		expect(transport.setHandlers).toHaveBeenCalledWith(handlers);
		expect(transport.start).toHaveBeenCalledTimes(1);
	});

	it("should lazily start transport before XMTP connect", async () => {
		const transport = createTransportMock({
			onSend: async (handlers, request) => {
				const params = request.params as {
					connectionId: string;
					nonce: string;
					from: { agentId: number; chain: string };
					to: { agentId: number; chain: string };
				};
				await handlers.onResult?.({
					from: 1,
					senderInboxId: "peer-inbox",
					message: {
						jsonrpc: "2.0",
						id: "connection-result-1",
						method: "connection/result",
						params: {
							requestId: String(request.id),
							requestNonce: params.nonce,
							from: params.to,
							to: params.from,
							status: "accepted",
							connectionId: params.connectionId,
							timestamp: "2026-03-11T00:00:00.000Z",
						},
					},
				});
			},
		});
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createResolver(resolvedAgent),
			transport,
		});

		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: INVITER_PRIVATE_KEY,
			expirySeconds: 3600,
		});

		const result = await orchestrator.connect(url);

		expect(result.success).toBe(true);
		expect(result.status).toBe("active");
		expect(result.receiptStatus).toBe("received");
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(transport.stop).toHaveBeenCalledTimes(1);
	});

	it("keeps an already managed transport running during connect", async () => {
		const transport = createTransportMock({
			onSend: async (handlers, request) => {
				const params = request.params as {
					connectionId: string;
					nonce: string;
					from: { agentId: number; chain: string };
					to: { agentId: number; chain: string };
				};
				await handlers.onResult?.({
					from: 1,
					senderInboxId: "peer-inbox",
					message: {
						jsonrpc: "2.0",
						id: "connection-result-2",
						method: "connection/result",
						params: {
							requestId: String(request.id),
							requestNonce: params.nonce,
							from: params.to,
							to: params.from,
							status: "accepted",
							connectionId: params.connectionId,
							timestamp: "2026-03-11T00:00:00.000Z",
						},
					},
				});
			},
		});
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createResolver(resolvedAgent),
			transport,
		});

		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: INVITER_PRIVATE_KEY,
			expirySeconds: 3600,
		});

		await orchestrator.start();
		const result = await orchestrator.connect(url);

		expect(result.success).toBe(true);
		expect(result.status).toBe("active");
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.stop).not.toHaveBeenCalled();
	});

	it("fails clearly when no transport is configured", async () => {
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createResolver(resolvedAgent),
		});

		const result = await orchestrator.connect("https://trustedagents.link/connect?invalid=true");

		expect(result).toEqual({
			success: false,
			error: "No transport configured. Provide config.transport or config.xmtp.",
		});
	});

	it("should stop transport when requested", async () => {
		const transport = createTransportMock();
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver: createResolver(resolvedAgent),
			transport,
		});

		await orchestrator.start();
		await orchestrator.stop();
		await orchestrator.stop();

		expect(transport.stop).toHaveBeenCalledTimes(1);
	});
});
