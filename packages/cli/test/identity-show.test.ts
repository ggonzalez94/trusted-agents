import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityShowCommand } from "../src/commands/identity-show.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as executionLib from "../src/lib/execution.js";

const { ADDRESS, mockOwsProvider } = vi.hoisted(() => {
	const addr = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as const;
	return {
		ADDRESS: addr,
		mockOwsProvider: vi.fn().mockImplementation(() => ({
			getAddress: vi.fn().mockResolvedValue(addr),
			signMessage: vi.fn(),
			signTypedData: vi.fn(),
			signTransaction: vi.fn(),
			signAuthorization: vi.fn(),
		})),
	};
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
	};
});

describe("tap identity show", () => {
	let tempRoot: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	const config: TrustedAgentsConfig = {
		agentId: -1,
		chain: "eip155:8453",
		ows: { wallet: "test-wallet", apiKey: "test-api-key" },
		dataDir: "/tmp/tap",
		chains: {
			"eip155:8453": {
				name: "Base",
				caip2: "eip155:8453",
				chainId: 8453,
				rpcUrl: "https://example.test/base",
				registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
			},
		},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60000,
		resolveCacheMaxEntries: 100,
		xmtpDbEncryptionKey: undefined,
		execution: {
			mode: "eip7702",
			paymasterProvider: "circle",
		},
	};

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-identity-show-"));
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
			messagingAddress: ADDRESS,
			executionAddress: ADDRESS,
			fundingAddress: ADDRESS,
			paymasterProvider: "circle",
			warnings: [],
		});
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.clearAllMocks();
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
		expect(output.data?.execution_address).toBe(ADDRESS);
		expect(output.data?.funding_address).toBe(ADDRESS);
	});

	it("shows a migration hint instead of an opaque OWS error for legacy raw-key agents", async () => {
		const dataDir = join(tempRoot, "legacy-agent");
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await writeFile(
			join(dataDir, "identity", "agent.key"),
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"utf-8",
		);

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({
			...config,
			agentId: 11,
			dataDir,
			ows: { wallet: "", apiKey: "" },
		});

		await identityShowCommand({ json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			error?: { message?: string };
		};
		expect(output.ok).toBe(false);
		expect(output.error?.message).toContain("tap migrate-wallet");
		expect(mockOwsProvider).not.toHaveBeenCalled();
	});
});
