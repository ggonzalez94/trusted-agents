import type { TrustedAgentsConfig } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityResolveSelfCommand } from "../src/commands/identity-resolve.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as contextLib from "../src/lib/context.js";

describe("identity resolve", () => {
	let stdoutWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;

	beforeEach(() => {
		stdoutWrites = [];
		process.exitCode = undefined;
		origStdoutWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("resolves self using config.agentId and the requested chain", async () => {
		const config: TrustedAgentsConfig = {
			agentId: 42,
			chain: "eip155:8453",
			ows: { wallet: "test-wallet", apiKey: "test-api-key" },
			dataDir: "/tmp/tap",
			chains: {
				"eip155:8453": {
					name: "Base",
					caip2: "eip155:8453",
					chainId: 8453,
					rpcUrl: "https://example.test/rpc",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
			},
			inviteExpirySeconds: 3600,
			resolveCacheTtlMs: 60000,
			resolveCacheMaxEntries: 100,
			xmtpDbEncryptionKey: undefined,
		};
		const resolve = vi.fn().mockResolvedValue({
			agentId: 42,
			chain: "eip155:1",
			ownerAddress: "0x1111111111111111111111111111111111111111",
			agentAddress: "0x2222222222222222222222222222222222222222",
			xmtpEndpoint: "0x2222222222222222222222222222222222222222",
			registrationFile: {
				name: "Self Agent",
				description: "Resolved self",
			},
			capabilities: ["chat"],
			resolvedAt: "2026-03-05T00:00:00.000Z",
		});

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);
		vi.spyOn(contextLib, "buildContext").mockReturnValue({
			config,
			trustStore: {} as never,
			resolver: { resolve } as never,
		});

		await identityResolveSelfCommand({ json: true }, "eip155:1");

		expect(resolve).toHaveBeenCalledWith(42, "eip155:1");
		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			data?: { agent_id?: number; chain?: string };
		};
		expect(output.ok).toBe(true);
		expect(output.data?.agent_id).toBe(42);
		expect(output.data?.chain).toBe("eip155:1");
	});
});
