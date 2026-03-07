import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrationFile, TrustedAgentsConfig } from "trusted-agents-core";
import * as core from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUpdateCommand } from "../src/commands/register.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as ipfsLib from "../src/lib/ipfs.js";
import * as walletLib from "../src/lib/wallet.js";

describe("register update", () => {
	const privateKey = "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11" as const;
	const agentAddress = privateKeyToAccount(privateKey).address;
	let tmpDir: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	function buildConfig(): TrustedAgentsConfig {
		return {
			agentId: 7,
			chain: "eip155:84532",
			privateKey,
			dataDir: tmpDir,
			chains: {
				"eip155:84532": {
					name: "Base Sepolia",
					rpcUrl: "https://example.test/rpc",
					registryAddress: "0x1234567890123456789012345678901234567890",
					blockExplorerUrl: "https://example.test/explorer",
				},
			},
			inviteExpirySeconds: 3600,
			resolveCacheTtlMs: 60000,
			resolveCacheMaxEntries: 100,
			xmtpEnv: "dev",
			xmtpDbEncryptionKey: undefined,
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
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({} as never);
		vi.spyOn(walletLib, "buildWalletClient").mockReturnValue({
			account: { address: agentAddress },
			chain: { id: 84532 },
		} as never);
		vi.spyOn(core.ERC8004Registry.prototype, "verifyDeployed").mockResolvedValue();
		vi.spyOn(core.ERC8004Registry.prototype, "getTokenURI").mockResolvedValue(
			"ipfs://existing-cid",
		);
		vi.spyOn(core.ERC8004Registry.prototype, "setAgentURI").mockResolvedValue();
		vi.spyOn(ipfsLib, "resolvePinataJwt").mockReturnValue(undefined);
		vi.spyOn(ipfsLib, "uploadToIpfsPinata").mockResolvedValue({
			cid: "pinata-cid",
			uri: "ipfs://pinata-cid",
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
		vi.restoreAllMocks();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("skips upload and transaction when merged manifest is unchanged", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		await registerUpdateCommand({}, { json: true });

		expect(ipfsLib.uploadToIpfsX402).not.toHaveBeenCalled();
		expect(core.ERC8004Registry.prototype.setAgentURI).not.toHaveBeenCalled();

		const output = lastJsonOutput() as {
			ok: boolean;
			data?: { no_change?: boolean; agent_uri?: string };
		};
		expect(output.ok).toBe(true);
		expect(output.data?.no_change).toBe(true);
		expect(output.data?.agent_uri).toBe("ipfs://existing-cid");
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
		expect(core.ERC8004Registry.prototype.setAgentURI).toHaveBeenCalledWith(
			7,
			"ipfs://uploaded-cid",
			expect.anything(),
		);

		const uploadPayload = uploadMock().mock.calls[0]?.[0] as RegistrationFile;
		expect(uploadPayload.name).toBe("Replacement Agent");
		expect(uploadPayload.trustedAgentProtocol.capabilities).toEqual(["search", "research"]);
		expect(stderrWrites.join("")).toContain("proceeding with replacement upload");
	});

	it("treats capability-only changes as a real update", async () => {
		vi.spyOn(core, "fetchRegistrationFile").mockResolvedValue(buildRegistrationFile(["chat"]));

		await registerUpdateCommand({ capabilities: "search" }, { json: true });

		expect(ipfsLib.uploadToIpfsX402).toHaveBeenCalledOnce();
		expect(core.ERC8004Registry.prototype.setAgentURI).toHaveBeenCalledOnce();

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
		expect(process.exitCode).toBe(2);

		const output = lastJsonOutput() as {
			ok: boolean;
			error?: { code?: string };
		};
		expect(output.ok).toBe(false);
		expect(output.error?.code).toBe("VALIDATION_ERROR");
	});
});
