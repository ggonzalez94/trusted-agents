import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInvite } from "trusted-agents-core";
import type {
	IAgentResolver,
	ProtocolMessage,
	ProtocolResponse,
	ResolvedAgent,
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

function createTransportMock(): TransportProvider & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	onMessage: ReturnType<typeof vi.fn>;
} {
	return {
		send: vi.fn(async (_peerId: number, request: ProtocolMessage) => ({
			jsonrpc: "2.0",
			id: request.id,
			result: { accepted: true, connectionId: "remote-conn-1" },
		})),
		onMessage: vi.fn(),
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

	it("should register inbound handler and start transport once", async () => {
		const transport = createTransportMock();
		const resolver = createResolver(resolvedAgent);
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			transport,
		});

		const handler = vi.fn(
			async (): Promise<ProtocolResponse> => ({
				jsonrpc: "2.0",
				id: "1",
				result: { ok: true },
			}),
		);

		await orchestrator.start({ onMessage: handler });
		await orchestrator.start({ onMessage: handler });

		expect(transport.onMessage).toHaveBeenCalledWith(handler);
		expect(transport.start).toHaveBeenCalledTimes(1);
	});

	it("should lazily start transport before XMTP connect", async () => {
		const transport = createTransportMock();
		const resolver = createResolver(resolvedAgent);
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
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
		expect(result.connectionId).toBe("remote-conn-1");
		expect(transport.start).toHaveBeenCalledTimes(1);
		expect(transport.send).toHaveBeenCalledTimes(1);
	});

	it("should stop transport when requested", async () => {
		const transport = createTransportMock();
		const resolver = createResolver(resolvedAgent);
		const orchestrator = new TrustedAgentsOrchestrator({
			privateKey: CONNECTOR_PRIVATE_KEY,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			transport,
		});

		await orchestrator.start();
		await orchestrator.stop();
		await orchestrator.stop();

		expect(transport.stop).toHaveBeenCalledTimes(1);
	});
});
