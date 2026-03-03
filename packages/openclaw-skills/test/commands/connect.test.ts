import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInvite } from "trusted-agents-core";
import type { IAgentResolver, ResolvedAgent } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeConnect } from "../../src/commands/connect.js";

function createMockResolver(agent: ResolvedAgent): IAgentResolver {
	return {
		resolve: vi.fn().mockResolvedValue(agent),
		resolveWithCache: vi.fn().mockResolvedValue(agent),
	};
}

const mockAgent: ResolvedAgent = {
	agentId: 1,
	chain: "eip155:84532",
	ownerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	agentAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
	endpoint: "https://agent1.example.com/a2a",
	capabilities: ["message/send"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "TestAgent",
		description: "A test agent",
		services: [{ name: "a2a", endpoint: "https://agent1.example.com/a2a" }],
		trustedAgentProtocol: {
			version: "0.1.0",
			agentAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			capabilities: ["message/send"],
		},
	},
	resolvedAt: new Date().toISOString(),
};

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
		const sendRequest = vi
			.fn()
			.mockResolvedValue({ jsonrpc: "2.0", id: "1", result: { accepted: true } });

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
			sendRequest,
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

		const result = await executeConnect({
			inviteUrl: url,
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("should fail with an invalid invite URL", async () => {
		const resolver = createMockResolver(mockAgent);

		const result = await executeConnect({
			inviteUrl: "https://trustedagents.link/connect?invalid=true",
			privateKey: connectorPrivateKey,
			agentId: 2,
			chain: "eip155:84532",
			dataDir: tmpDir,
			resolver,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid invite URL");
	});
});
