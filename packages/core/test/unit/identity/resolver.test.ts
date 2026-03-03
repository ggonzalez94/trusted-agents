import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResolver } from "../../../src/identity/resolver.js";
import { VALID_REGISTRATION_FILE } from "../../fixtures/registration-files.js";
import { ALICE } from "../../fixtures/test-keys.js";
import { createMockPublicClient } from "../../helpers/mock-chain.js";

describe("AgentResolver", () => {
	const chains = {
		"eip155:1": {
			rpcUrl: "https://rpc.example.com",
			registryAddress: "0x0000000000000000000000000000000000001234" as `0x${string}`,
		},
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("should resolve an agent by querying the chain and fetching the registration file", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		// Mock the fetch call for the registration file
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(VALID_REGISTRATION_FILE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const resolver = new AgentResolver(chains, () => mockClient);

		const result = await resolver.resolve(1, "eip155:1");

		expect(result.agentId).toBe(1);
		expect(result.chain).toBe("eip155:1");
		expect(result.ownerAddress).toBe(ALICE.address);
		expect(result.agentAddress).toBe(ALICE.address);
		expect(result.endpoint).toBe("https://alice-agent.example.com/a2a");
		expect(result.capabilities).toEqual(["scheduling", "general-chat"]);
		expect(result.resolvedAt).toBeDefined();

		fetchMock.mockRestore();
	});

	it("should throw for an unknown chain", async () => {
		const resolver = new AgentResolver(chains, () => createMockPublicClient());

		await expect(resolver.resolve(1, "eip155:999")).rejects.toThrow("Unknown chain");
	});

	it("should cache resolved agents and return cached results within maxAge", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(VALID_REGISTRATION_FILE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const resolver = new AgentResolver(chains, () => mockClient);

		const result1 = await resolver.resolveWithCache(1, "eip155:1");
		const result2 = await resolver.resolveWithCache(1, "eip155:1");

		// Second call should use cache - fetch should only be called once
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result1.endpoint).toBe(result2.endpoint);

		fetchMock.mockRestore();
	});
});
