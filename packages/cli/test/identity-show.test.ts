import type { TrustedAgentsConfig } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityShowCommand } from "../src/commands/identity-show.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as executionLib from "../src/lib/execution.js";

describe("tap identity show", () => {
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	const config: TrustedAgentsConfig = {
		agentId: -1,
		chain: "eip155:84532",
		privateKey: "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11",
		dataDir: "/tmp/tap",
		chains: {
			"eip155:84532": {
				name: "Base Sepolia",
				caip2: "eip155:84532",
				chainId: 84532,
				rpcUrl: "https://example.test/base-sepolia",
				registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
			},
		},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60000,
		resolveCacheMaxEntries: 100,
		xmtpEnv: "dev",
		xmtpDbEncryptionKey: undefined,
		execution: {
			mode: "eip7702",
			paymasterProvider: "circle",
		},
	};

	beforeEach(() => {
		stdoutWrites = [];
		stderrWrites = [];
		process.exitCode = undefined;
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			stderrWrites.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);
		vi.spyOn(executionLib, "getExecutionPreview").mockResolvedValue({
			requestedMode: "eip7702",
			mode: "eip7702",
			messagingAddress: "0xE4a5fA6c3a91B3e8FbA6ecbE261B8f7Ba6c58e5B",
			executionAddress: "0xE4a5fA6c3a91B3e8FbA6ecbE261B8f7Ba6c58e5B",
			fundingAddress: "0xE4a5fA6c3a91B3e8FbA6ecbE261B8f7Ba6c58e5B",
			paymasterProvider: "circle",
			warnings: [],
		});
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("works before registration and shows the execution funding address", async () => {
		await identityShowCommand({ json: true });

		expect(configLoader.loadConfig).toHaveBeenCalledWith({ json: true }, { requireAgentId: false });

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			data?: Record<string, unknown>;
		};
		expect(output.ok).toBe(true);
		expect(output.data?.agent_id).toBe(-1);
		expect(output.data?.execution_mode).toBe("eip7702");
		expect(output.data?.execution_address).toBe("0xE4a5fA6c3a91B3e8FbA6ecbE261B8f7Ba6c58e5B");
		expect(output.data?.funding_address).toBe("0xE4a5fA6c3a91B3e8FbA6ecbE261B8f7Ba6c58e5B");
	});
});
