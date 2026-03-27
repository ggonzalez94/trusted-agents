import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrationFile, TrustedAgentsConfig } from "trusted-agents-core";
import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUpdateCommand } from "../src/commands/register.js";
import { getUsdcAsset } from "../src/lib/assets.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as executionLib from "../src/lib/execution.js";
import * as ipfsLib from "../src/lib/ipfs.js";
import * as walletLib from "../src/lib/wallet.js";

const { agentAddress, mockOwsProvider } = vi.hoisted(() => {
	const addr = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as `0x${string}`;
	const mockProvider = vi.fn().mockImplementation(() => ({
		getAddress: vi.fn().mockResolvedValue(addr),
		signMessage: vi.fn(),
		signTypedData: vi.fn(),
		signTransaction: vi.fn(),
		signAuthorization: vi.fn(),
	}));
	return { agentAddress: addr, mockOwsProvider: mockProvider };
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
	};
});

describe("register update", () => {
	let tmpDir: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	function buildConfig(): TrustedAgentsConfig {
		return {
			agentId: 7,
			chain: "eip155:8453",
			ows: { wallet: "test-wallet", apiKey: "test-api-key" },
			dataDir: tmpDir,
			chains: {
				"eip155:8453": {
					name: "Base",
					caip2: "eip155:8453",
					chainId: 8453,
					rpcUrl: "https://example.test/base-mainnet",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
					blockExplorerUrl: "https://example.test/base-explorer",
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
	}

	function buildRegistrationFile(capabilities: string[]): RegistrationFile {
		return {
			type: "eip-8004-registration-v1",
			name: "Existing Agent",
			description: "Existing Description",
			services: [{ name: "xmtp", endpoint: agentAddress }],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress,
				capabilities,
				execution: {
					mode: "eip4337",
					address: "0x00000000000000000000000000000000000000aa",
					paymaster: "candide",
				},
			},
		};
	}

	function lastJsonOutput(): Record<string, unknown> {
		return JSON.parse(stdoutWrites.join("")) as Record<string, unknown>;
	}

	function uploadMock(): ReturnType<typeof vi.fn> {
		return ipfsLib.uploadToIpfsX402 as unknown as ReturnType<typeof vi.fn>;
	}

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-register-update-test-"));
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

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(buildConfig());
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			readContract: vi.fn().mockResolvedValue(100_000n),
		} as never);
		vi.spyOn(core.ERC8004Registry.prototype, "verifyDeployed").mockResolvedValue();
		vi.spyOn(core.ERC8004Registry.prototype, "getTokenURI").mockResolvedValue(
			"ipfs://existing-cid",
		);
		vi.spyOn(executionLib, "getExecutionPreview").mockResolvedValue({
			requestedMode: "eip4337",
			mode: "eip4337",
			messagingAddress: agentAddress,
			executionAddress: "0x00000000000000000000000000000000000000aa",
			fundingAddress: "0x00000000000000000000000000000000000000aa",
			paymasterProvider: "candide",
			warnings: [],
		});
		vi.spyOn(executionLib, "ensureExecutionReady").mockResolvedValue();
		vi.spyOn(executionLib, "executeContractCalls").mockResolvedValue({
			requestedMode: "eip4337",
			mode: "eip4337",
			messagingAddress: agentAddress,
			executionAddress: "0x00000000000000000000000000000000000000aa",
			fundingAddress: "0x00000000000000000000000000000000000000aa",
			paymasterProvider: "candide",
			warnings: [],
			entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
			entryPointVersion: "0.7",
			gasPaymentMode: "erc20-usdc",
			transactionHash: "0xabc",
			userOperationHash: "0xdef",
			transactionReceipt: {
				transactionHash: "0xabc",
				logs: [],
			},
		} as never);
		vi.spyOn(ipfsLib, "resolvePinataJwt").mockImplementation((flagValue?: string) => flagValue);
		vi.spyOn(ipfsLib, "uploadToIpfsPinata").mockResolvedValue({
			cid: "pinata-cid",
			uri: "ipfs://pinata-cid",
		});
		vi.spyOn(ipfsLib, "uploadToIpfsTack").mockResolvedValue({
			cid: "tack-cid",
			uri: "ipfs://tack-cid",
		});
		vi.spyOn(ipfsLib, "uploadToIpfsX402").mockResolvedValue({
			cid: "uploaded-cid",
			uri: "ipfs://uploaded-cid",
		});
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.clearAllMocks();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("skips upload and transaction when merged manifest is unchanged", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));
		vi.spyOn(executionLib, "ensureExecutionReady").mockRejectedValue(
			new Error("should not preflight a no-op update"),
		);

		await registerUpdateCommand({}, { json: true });

		const output = lastJsonOutput() as {
			ok: boolean;
			data?: { no_change?: boolean; agent_uri?: string };
		};

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(executionLib.executeContractCalls).not.toHaveBeenCalled();
		expect(executionLib.ensureExecutionReady).not.toHaveBeenCalled();

		expect(output.status).toBe("ok");
		expect(output.data?.no_change).toBe(true);
		expect(output.data?.agent_uri).toBe("ipfs://existing-cid");
	});

	it("skips paymaster preflight when --uri already matches the registry", async () => {
		vi.spyOn(executionLib, "ensureExecutionReady").mockRejectedValue(
			new Error("should not preflight a no-op uri update"),
		);

		await registerUpdateCommand({ uri: "ipfs://existing-cid" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(executionLib.executeContractCalls).not.toHaveBeenCalled();
		expect(executionLib.ensureExecutionReady).not.toHaveBeenCalled();

		const output = lastJsonOutput() as {
			ok: boolean;
			data?: { no_change?: boolean; agent_uri?: string };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.no_change).toBe(true);
		expect(output.data?.agent_uri).toBe("ipfs://existing-cid");
	});

	it("fails before x402 upload when execution preflight fails", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));
		vi.spyOn(executionLib, "ensureExecutionReady").mockRejectedValue(
			new Error("Circle permit preflight failed"),
		);

		await registerUpdateCommand({ description: "Updated" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(executionLib.executeContractCalls).not.toHaveBeenCalled();

		const output = lastJsonOutput() as {
			ok: boolean;
			error?: { message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.message).toContain("Circle permit preflight failed");
	});

	it("proceeds with full replacement even when the current manifest cannot be fetched", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockRejectedValue(new Error("manifest unavailable"));

		await registerUpdateCommand(
			{
				name: "Replacement Agent",
				description: "Replacement Description",
				capabilities: "search,research",
			},
			{ json: true, verbose: true },
		);

		expect(ipfsLib.uploadToIpfsX402).toHaveBeenCalledOnce();
		expect(executionLib.executeContractCalls).toHaveBeenCalledOnce();

		const uploadPayload = uploadMock().mock.calls[0]?.[0] as RegistrationFile;
		expect(uploadPayload.name).toBe("Replacement Agent");
		expect(uploadPayload.trustedAgentProtocol.capabilities).toEqual(["search", "research"]);
		expect(uploadPayload.trustedAgentProtocol.execution?.mode).toBe("eip4337");
		expect(stderrWrites.join("")).toContain("proceeding with replacement upload");
	});

	it("treats capability-only changes as a real update", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		await registerUpdateCommand({ capabilities: "search" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).toHaveBeenCalledOnce();
		expect(executionLib.executeContractCalls).toHaveBeenCalledOnce();
		expect(
			(
				executionLib.executeContractCalls as unknown as {
					mock: { calls: unknown[][] };
				}
			).mock.calls[0]?.[4],
		).toMatchObject({
			preview: {
				mode: "eip4337",
				paymasterProvider: "candide",
			},
		});

		const uploadPayload = uploadMock().mock.calls[0]?.[0] as RegistrationFile;
		expect(uploadPayload.trustedAgentProtocol.capabilities).toEqual(["search"]);
	});

	it("allows clearing capabilities with an explicit empty string", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(
			buildRegistrationFile(["chat", "research"]),
		);

		await registerUpdateCommand({ capabilities: "" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).toHaveBeenCalledOnce();

		const uploadPayload = uploadMock().mock.calls[0]?.[0] as RegistrationFile;
		expect(uploadPayload.trustedAgentProtocol.capabilities).toEqual([]);
	});

	it("uses Tack provider from config when requested", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({
			...buildConfig(),
			ipfs: {
				provider: "tack",
			},
		});

		await registerUpdateCommand({ capabilities: "search" }, { json: true });

		expect(ipfsLib.uploadToIpfsTack).toHaveBeenCalledOnce();
		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(executionLib.executeContractCalls).toHaveBeenCalledOnce();
		expect(ipfsLib.uploadToIpfsTack).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				apiUrl: "https://tack.taiko.xyz",
			}),
		);
	});

	it("honors explicit pinata provider when JWT is supplied", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		await registerUpdateCommand(
			{
				capabilities: "search",
				ipfsProvider: "pinata",
				pinataJwt: "flag-jwt",
			},
			{ json: true },
		);

		expect(ipfsLib.uploadToIpfsPinata).toHaveBeenCalledOnce();
		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(ipfsLib.uploadToIpfsTack).not.toHaveBeenCalled();
	});

	it("fails when pinata provider is selected without JWT", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		await registerUpdateCommand(
			{
				capabilities: "search",
				ipfsProvider: "pinata",
			},
			{ json: true },
		);

		expect(ipfsLib.uploadToIpfsPinata).not.toHaveBeenCalled();
		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(ipfsLib.uploadToIpfsTack).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);

		const output = lastJsonOutput() as {
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Pinata provider selected");
	});

	it("rejects mixing --uri with manifest overrides before any chain calls", async () => {
		await registerUpdateCommand(
			{
				uri: "https://example.com/manifest.json",
				name: "Conflicting Name",
			},
			{ json: true },
		);

		expect(walletLib.buildPublicClient).not.toHaveBeenCalled();
		expect(core.ERC8004Registry.prototype.getTokenURI).not.toHaveBeenCalled();
		expect(executionLib.executeContractCalls).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);

		const output = lastJsonOutput() as {
			ok: boolean;
			error?: { code?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
	});

	it("tops up the messaging identity from the Base execution account before x402 upload", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		const readContract = vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(50_000n);
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			readContract,
		} as never);
		vi.spyOn(executionLib, "getExecutionPreview").mockImplementation(
			async (_config, chainConfig) => {
				if (chainConfig.caip2 === "eip155:8453") {
					return {
						requestedMode: "eip4337",
						mode: "eip4337",
						messagingAddress: agentAddress,
						executionAddress: "0x00000000000000000000000000000000000000bb",
						fundingAddress: "0x00000000000000000000000000000000000000bb",
						paymasterProvider: "candide",
						warnings: [],
					};
				}

				return {
					requestedMode: "eip4337",
					mode: "eip4337",
					messagingAddress: agentAddress,
					executionAddress: "0x00000000000000000000000000000000000000aa",
					fundingAddress: "0x00000000000000000000000000000000000000aa",
					paymasterProvider: "candide",
					warnings: [],
				};
			},
		);

		await registerUpdateCommand({ capabilities: "search" }, { json: true });

		expect(executionLib.executeContractCalls).toHaveBeenCalledTimes(2);
		const topUpCall = (
			executionLib.executeContractCalls as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0];
		const updateCall = (
			executionLib.executeContractCalls as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[1];

		expect(topUpCall?.[1]).toMatchObject({ caip2: "eip155:8453" });
		expect(topUpCall?.[3]).toHaveLength(1);
		expect((topUpCall?.[3] as Array<{ to: string }>)[0]?.to).toBe(
			getUsdcAsset("eip155:8453")?.address,
		);
		expect(updateCall?.[1]).toMatchObject({ caip2: "eip155:8453" });
	});
});
