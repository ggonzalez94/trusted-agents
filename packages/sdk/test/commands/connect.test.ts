import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInvite } from "trusted-agents-core";
import type { IAgentResolver, ResolvedAgent, TransportProvider } from "trusted-agents-core";
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

function createMockTransport(response: unknown): TransportProvider {
	return {
		send: vi.fn().mockResolvedValue(response),
		onMessage: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
	};
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

	it("should connect successfully with a valid invite", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});

		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport({
			jsonrpc: "2.0",
			id: "1",
			result: { accepted: true },
		});

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
		expect(result.connectionId).toBeTruthy();
		expect(result.peerName).toBe("TestAgent");
		expect(result.status).toBe("active");
		expect(resolver.resolve).toHaveBeenCalledWith(1, "eip155:84532");
	});

	it("should fail with an expired invite", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: -1,
		});

		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport({});

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
		expect(result.error).toContain("expired");
	});

	it("should fail with an invalid invite URL", async () => {
		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport({});

		const result = await executeConnect({
			inviteUrl: "https://trustedagents.link/connect?invalid=true",
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			transport,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid invite URL");
	});

	it("should use remote connectionId when provided by acceptance response", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:84532",
			privateKey: inviterPrivateKey,
			expirySeconds: 3600,
		});

		const resolver = createMockResolver(mockAgent);
		const transport = createMockTransport({
			jsonrpc: "2.0",
			id: "1",
			result: { accepted: true, connectionId: "remote-conn-123" },
		});

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
		expect(result.connectionId).toBe("remote-conn-123");
	});
});
