import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrationFile } from "trusted-agents-core";
import * as core from "trusted-agents-core";
import { getUsdcAsset } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUpdateCommand } from "../src/commands/register.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as ipfsLib from "../src/lib/ipfs.js";
import * as shellLib from "../src/lib/shell.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import {
	TEST_BASE_CHAIN,
	buildMockExecutionPreview,
	buildTestConfig,
} from "./helpers/config-fixtures.js";

const agentAddress = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as `0x${string}`;
const mockOwsProvider = vi.fn().mockImplementation(() => ({
	getAddress: vi.fn().mockResolvedValue(agentAddress),
	signMessage: vi.fn(),
	signTypedData: vi.fn(),
	signTransaction: vi.fn(),
	signAuthorization: vi.fn(),
}));

describe("register update", () => {
	let tmpDir: string;
	let originalHermesHome: string | undefined;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	function buildConfig() {
		return buildTestConfig({
			agentId: 7,
			dataDir: tmpDir,
			chains: {
				"eip155:8453": {
					...TEST_BASE_CHAIN,
					rpcUrl: "https://example.test/base-mainnet",
					blockExplorerUrl: "https://example.test/base-explorer",
				},
			},
		});
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
		originalHermesHome = process.env.HERMES_HOME;
		process.exitCode = undefined;

		vi.spyOn(core, "OwsSigningProvider").mockImplementation(mockOwsProvider as never);
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(buildConfig());
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			readContract: vi.fn().mockResolvedValue(100_000n),
		} as never);
		vi.spyOn(core.ERC8004Registry.prototype, "verifyDeployed").mockResolvedValue();
		vi.spyOn(core.ERC8004Registry.prototype, "getTokenURI").mockResolvedValue(
			"ipfs://existing-cid",
		);
		vi.spyOn(core, "getExecutionPreview").mockResolvedValue(
			buildMockExecutionPreview(agentAddress, {
				requestedMode: "eip4337",
				mode: "eip4337",
				executionAddress: "0x00000000000000000000000000000000000000aa",
				fundingAddress: "0x00000000000000000000000000000000000000aa",
				paymasterProvider: "candide",
			}),
		);
		vi.spyOn(core, "ensureExecutionReady").mockResolvedValue();
		vi.spyOn(core, "executeContractCalls").mockResolvedValue({
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
		vi.spyOn(shellLib, "commandExists").mockResolvedValue(false);
	});

	afterEach(async () => {
		if (originalHermesHome === undefined) {
			process.env.HERMES_HOME = undefined;
		} else {
			process.env.HERMES_HOME = originalHermesHome;
		}
		process.exitCode = undefined;
		vi.clearAllMocks();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("skips upload and transaction when merged manifest is unchanged", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));
		vi.spyOn(core, "ensureExecutionReady").mockRejectedValue(
			new Error("should not preflight a no-op update"),
		);

		await registerUpdateCommand({}, { json: true });

		const output = lastJsonOutput() as {
			ok: boolean;
			data?: { no_change?: boolean; agent_uri?: string };
		};

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(core.executeContractCalls).not.toHaveBeenCalled();
		expect(core.ensureExecutionReady).not.toHaveBeenCalled();

		expect(output.status).toBe("ok");
		expect(output.data?.no_change).toBe(true);
		expect(output.data?.agent_uri).toBe("ipfs://existing-cid");
	});

	it("skips paymaster preflight when --uri already matches the registry", async () => {
		vi.spyOn(core, "ensureExecutionReady").mockRejectedValue(
			new Error("should not preflight a no-op uri update"),
		);

		await registerUpdateCommand({ uri: "ipfs://existing-cid" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(core.executeContractCalls).not.toHaveBeenCalled();
		expect(core.ensureExecutionReady).not.toHaveBeenCalled();

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
		vi.spyOn(core, "ensureExecutionReady").mockRejectedValue(
			new Error("Circle permit preflight failed"),
		);

		await registerUpdateCommand({ description: "Updated" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(core.executeContractCalls).not.toHaveBeenCalled();

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
		expect(core.executeContractCalls).toHaveBeenCalledOnce();

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
		expect(core.executeContractCalls).toHaveBeenCalledOnce();
		expect(
			(
				core.executeContractCalls as unknown as {
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
		expect(core.executeContractCalls).toHaveBeenCalledOnce();
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

		expect(core.buildChainPublicClient).not.toHaveBeenCalled();
		expect(core.ERC8004Registry.prototype.getTokenURI).not.toHaveBeenCalled();
		expect(core.executeContractCalls).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);

		const output = lastJsonOutput() as {
			ok: boolean;
			error?: { code?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
	});

	it("includes the Hermes configure hint when a Hermes install is present", async () => {
		const hermesHome = join(tmpDir, "hermes-home");
		await mkdir(hermesHome, { recursive: true });
		process.env.HERMES_HOME = hermesHome;

		await registerUpdateCommand({ uri: "ipfs://new-cid" }, { json: true });

		const output = lastJsonOutput() as {
			status: string;
			data?: { next_steps?: string[] };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.next_steps).toContain(
			"Configure Hermes plugin: tap hermes configure --name default",
		);
	});

	it("tops up the messaging identity from the Base execution account before x402 upload", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		const readContract = vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(50_000n);
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			readContract,
		} as never);
		vi.spyOn(core, "getExecutionPreview").mockImplementation(async (_config, chainConfig) => {
			const addr =
				chainConfig.caip2 === "eip155:8453"
					? "0x00000000000000000000000000000000000000bb"
					: "0x00000000000000000000000000000000000000aa";
			return buildMockExecutionPreview(agentAddress, {
				requestedMode: "eip4337",
				mode: "eip4337",
				executionAddress: addr,
				fundingAddress: addr,
				paymasterProvider: "candide",
			});
		});

		await registerUpdateCommand({ capabilities: "search" }, { json: true });

		expect(core.executeContractCalls).toHaveBeenCalledTimes(2);
		const topUpCall = (core.executeContractCalls as unknown as { mock: { calls: unknown[][] } })
			.mock.calls[0];
		const updateCall = (core.executeContractCalls as unknown as { mock: { calls: unknown[][] } })
			.mock.calls[1];

		expect(topUpCall?.[1]).toMatchObject({ caip2: "eip155:8453" });
		expect(topUpCall?.[3]).toHaveLength(1);
		expect((topUpCall?.[3] as Array<{ to: string }>)[0]?.to).toBe(
			getUsdcAsset("eip155:8453")?.address,
		);
		expect(updateCall?.[1]).toMatchObject({ caip2: "eip155:8453" });
	});
});
