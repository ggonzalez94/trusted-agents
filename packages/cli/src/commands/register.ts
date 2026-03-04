import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import {
	ERC8004Registry,
	validateRegistrationFile,
} from "trusted-agents-core";
import type { RegistrationFile } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import type { GlobalOptions } from "../types.js";
import { loadConfig, resolveConfigPath } from "../lib/config-loader.js";
import { error, info, success, verbose } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";
import { uploadToIpfsX402, uploadToIpfsPinata, resolvePinataJwt } from "../lib/ipfs.js";
import { buildWalletClient, buildPublicClient } from "../lib/wallet.js";

export interface RegisterOptions {
	name: string;
	description: string;
	capabilities: string;
	uri?: string;
	pinataJwt?: string;
}

/** Deterministic JSON serialization for content comparison. */
function canonicalJson(obj: unknown): string {
	return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

/** SHA-256 hash of the canonical JSON representation. */
function contentHash(registrationFile: RegistrationFile): string {
	return createHash("sha256").update(canonicalJson(registrationFile)).digest("hex");
}

interface IpfsCache {
	[contentHash: string]: { cid: string; uri: string };
}

async function loadIpfsCache(dataDir: string): Promise<IpfsCache> {
	const cachePath = `${dataDir}/ipfs-cache.json`;
	try {
		return JSON.parse(await readFile(cachePath, "utf-8")) as IpfsCache;
	} catch {
		return {};
	}
}

async function saveIpfsCache(dataDir: string, cache: IpfsCache): Promise<void> {
	const cachePath = `${dataDir}/ipfs-cache.json`;
	await mkdir(dirname(cachePath), { recursive: true });
	await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

/** Check if the CID is still reachable via an IPFS gateway. */
async function verifyCidAccessible(cid: string): Promise<boolean> {
	try {
		const response = await fetch(`https://ipfs.io/ipfs/${cid}`, {
			method: "HEAD",
			signal: AbortSignal.timeout(5000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Upload a registration file to IPFS, reusing a cached CID if the content is unchanged.
 *
 * Priority: --uri (skip upload) > cached CID > x402 > Pinata JWT (legacy)
 */
async function resolveAgentURI(
	registrationFile: RegistrationFile,
	privateKey: `0x${string}`,
	dataDir: string,
	cmdOpts: { uri?: string; pinataJwt?: string; name: string },
	opts: GlobalOptions,
): Promise<{ agentURI: string; ipfsCid?: string } | null> {
	// 1. Explicit URI — no upload needed
	if (cmdOpts.uri) {
		info(`Using provided URI: ${cmdOpts.uri}`, opts);
		return { agentURI: cmdOpts.uri };
	}

	// 2. Check IPFS cache — skip upload if identical content was previously uploaded
	const hash = contentHash(registrationFile);
	const cache = await loadIpfsCache(dataDir);
	const cached = cache[hash];
	if (cached) {
		verbose(`Found cached IPFS CID for content hash ${hash.slice(0, 12)}…`, opts);
		const accessible = await verifyCidAccessible(cached.cid);
		if (accessible) {
			info(`Reusing existing IPFS upload: ${cached.uri} (content unchanged)`, opts);
			return { agentURI: cached.uri, ipfsCid: cached.cid };
		}
		verbose("Cached CID not reachable via gateway, re-uploading...", opts);
	}

	// 3. Try x402 (always pays with USDC on Base mainnet — no account needed)
	const jwt = resolvePinataJwt(cmdOpts.pinataJwt);
	if (!jwt) {
		info("Uploading registration file to IPFS via x402 (paying with USDC on Base mainnet)...", opts);
		try {
			const ipfs = await uploadToIpfsX402(registrationFile, privateKey);
			info(`Uploaded to IPFS: ${ipfs.uri}`, opts);
			cache[hash] = { cid: ipfs.cid, uri: ipfs.uri };
			await saveIpfsCache(dataDir, cache);
			return { agentURI: ipfs.uri, ipfsCid: ipfs.cid };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			verbose(`x402 upload failed: ${msg}`, opts);
			error(
				"UPLOAD_ERROR",
				`IPFS upload via x402 failed: ${msg}\n\n` +
				`x402 requires USDC on Base mainnet (not testnet) to pay for IPFS pinning.\n` +
				`Send USDC to your agent's address on Base (chain ID 8453).\n\n` +
				`Alternatives:\n` +
				`  --pinata-jwt <token>  Use a Pinata API key instead (works on any chain)\n` +
				`  --uri <url>           Skip IPFS upload with a pre-hosted registration file`,
				opts,
			);
			return null;
		}
	}

	// 4. Pinata JWT (authenticated API)
	info("Uploading registration file to IPFS via Pinata...", opts);
	const ipfs = await uploadToIpfsPinata(registrationFile, jwt, `tap-${cmdOpts.name}`);
	info(`Uploaded to IPFS: ${ipfs.uri}`, opts);
	cache[hash] = { cid: ipfs.cid, uri: ipfs.uri };
	await saveIpfsCache(dataDir, cache);
	return { agentURI: ipfs.uri, ipfsCid: ipfs.cid };
}

export async function registerCommand(
	cmdOpts: RegisterOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		// Load config — agent_id may not exist yet (pre-registration)
		const config = await loadConfig(opts, { requireAgentId: false });

		const chainConfig = config.chains[config.chain];
		if (!chainConfig) {
			error("VALIDATION_ERROR", `No chain config for ${config.chain}`, opts);
			process.exitCode = 1;
			return;
		}

		const account = privateKeyToAccount(config.privateKey);
		const agentAddress = account.address;

		// Build registration file
		const capabilities = cmdOpts.capabilities
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean);

		const registrationFile: RegistrationFile = {
			type: "eip-8004-registration-v1",
			name: cmdOpts.name,
			description: cmdOpts.description,
			services: [
				{ name: "xmtp", endpoint: agentAddress },
			],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress,
				capabilities,
			},
		};

		// Validate before uploading
		validateRegistrationFile(registrationFile);
		verbose("Registration file validated", opts);

		// Upload to IPFS (x402 or Pinata JWT) or use provided URI
		const result = await resolveAgentURI(registrationFile, config.privateKey, config.dataDir, cmdOpts, opts);
		if (!result) {
			process.exitCode = 1;
			return;
		}

		// Register on-chain
		info(`Registering on ${chainConfig.name} (${config.chain})...`, opts);
		const publicClient = buildPublicClient(chainConfig);
		const walletClient = buildWalletClient(config.privateKey, chainConfig);
		const registry = new ERC8004Registry(publicClient, chainConfig.registryAddress);

		await registry.verifyDeployed();
		const agentId = await registry.register(result.agentURI, walletClient);
		info(`Registered! Agent ID: ${agentId}`, opts);

		// Auto-update config.yaml with the new agent_id
		const configPath = resolveConfigPath(opts);
		await updateConfigAgentId(configPath, agentId);
		verbose(`Updated ${configPath} with agent_id: ${agentId}`, opts);

		const explorerUrl = chainConfig.blockExplorerUrl
			? `${chainConfig.blockExplorerUrl}/address/${chainConfig.registryAddress}`
			: undefined;

		success(
			{
				agent_id: agentId,
				chain: config.chain,
				address: agentAddress,
				agent_uri: result.agentURI,
				ipfs_cid: result.ipfsCid,
				explorer: explorerUrl,
				next_steps: [
					`Agent #${agentId} is live on ${chainConfig.name}`,
					`Create an invite: tap invite create`,
					`Share the link with a peer, who runs: tap connect <url> --yes`,
				],
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function registerUpdateCommand(
	cmdOpts: Omit<RegisterOptions, "capabilities" | "description"> & {
		description?: string;
		capabilities?: string;
	},
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		const chainConfig = config.chains[config.chain];
		if (!chainConfig) {
			error("VALIDATION_ERROR", `No chain config for ${config.chain}`, opts);
			process.exitCode = 1;
			return;
		}

		const account = privateKeyToAccount(config.privateKey);
		const agentAddress = account.address;

		// Build updated registration file
		const capabilities = cmdOpts.capabilities
			? cmdOpts.capabilities.split(",").map((c) => c.trim()).filter(Boolean)
			: [];

		const registrationFile: RegistrationFile = {
			type: "eip-8004-registration-v1",
			name: cmdOpts.name,
			description: cmdOpts.description ?? "",
			services: [
				{ name: "xmtp", endpoint: agentAddress },
			],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress,
				capabilities,
			},
		};

		validateRegistrationFile(registrationFile);

		// Upload to IPFS or use provided URI
		const result = await resolveAgentURI(registrationFile, config.privateKey, config.dataDir, cmdOpts, opts);
		if (!result) {
			process.exitCode = 1;
			return;
		}

		// Update on-chain
		info(`Updating agent #${config.agentId} URI on ${chainConfig.name}...`, opts);
		const publicClient = buildPublicClient(chainConfig);
		const walletClient = buildWalletClient(config.privateKey, chainConfig);
		const registry = new ERC8004Registry(publicClient, chainConfig.registryAddress);

		await registry.verifyDeployed();
		await registry.setAgentURI(config.agentId, result.agentURI, walletClient);

		success(
			{
				agent_id: config.agentId,
				agent_uri: result.agentURI,
				ipfs_cid: result.ipfsCid,
				updated: true,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

async function updateConfigAgentId(configPath: string, agentId: number): Promise<void> {
	if (!existsSync(configPath)) return;

	const content = await readFile(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown>;
	yaml.agent_id = agentId;
	await writeFile(configPath, YAML.stringify(yaml), "utf-8");
}
