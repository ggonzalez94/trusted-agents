import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	ERC8004Registry,
	ERC8004_ABI,
	fetchRegistrationFile,
	validateRegistrationFile,
} from "trusted-agents-core";
import type {
	IpfsUploadProvider,
	RegistrationFile,
	RegistrationFileExecution,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import type { SigningProvider } from "trusted-agents-core";
import { OwsSigningProvider } from "trusted-agents-core";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import YAML from "yaml";
import { getUsdcAsset } from "../lib/assets.js";
import { loadConfig, resolveConfigPath } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import {
	type ExecutionPreview,
	ensureExecutionReady,
	executeContractCalls,
	getExecutionPreview,
} from "../lib/execution.js";
import {
	resolveEffectiveIpfsProvider,
	resolvePinataJwt,
	resolveTackApiUrl,
	uploadToIpfsPinata,
	uploadToIpfsTack,
	uploadToIpfsX402,
} from "../lib/ipfs.js";
import { error, info, success, verbose } from "../lib/output.js";
import { commandExists } from "../lib/shell.js";
import { buildPublicClient } from "../lib/wallet.js";
import type { GlobalOptions } from "../types.js";

export interface RegisterOptions {
	name: string;
	description: string;
	capabilities: string;
	uri?: string;
	pinataJwt?: string;
	ipfsProvider?: string;
}

export interface RegisterUpdateOptions {
	name?: string;
	description?: string;
	capabilities?: string;
	uri?: string;
	pinataJwt?: string;
	ipfsProvider?: string;
}

function parseCapabilities(input: string): string[] {
	return input
		.split(",")
		.map((capability) => capability.trim())
		.filter(Boolean);
}

function buildOpenClawConfigStep(dataDir: string): string {
	const absPath = resolve(dataDir);
	const identity = JSON.stringify([
		{ name: "default", dataDir: absPath, reconcileIntervalMinutes: 10 },
	]);
	const escaped = identity.replace(/'/g, "'\\''");
	return `Configure OpenClaw plugin: openclaw config set plugins.entries.trusted-agents-tap.config.identities '${escaped}' --json`;
}

function upsertXmtpService(
	services: RegistrationFile["services"],
	agentAddress: `0x${string}`,
): RegistrationFile["services"] {
	let hasXmtp = false;
	const updated = services.map((service) => {
		if (service.name !== "xmtp") {
			return service;
		}
		hasXmtp = true;
		return { ...service, endpoint: agentAddress };
	});

	if (hasXmtp) {
		return updated;
	}

	return [{ name: "xmtp", endpoint: agentAddress }, ...updated];
}

function buildRegistrationFile(
	name: string,
	description: string,
	capabilities: string[],
	agentAddress: `0x${string}`,
	execution?: RegistrationFileExecution,
): RegistrationFile {
	return {
		type: "eip-8004-registration-v1",
		name,
		description,
		services: [{ name: "xmtp", endpoint: agentAddress }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress,
			capabilities,
			execution,
		},
	};
}

export function buildUpdatedRegistrationFile(
	current: RegistrationFile,
	agentAddress: `0x${string}`,
	execution: RegistrationFileExecution | undefined,
	updates: {
		name?: string;
		description?: string;
		capabilities?: string[];
	},
): RegistrationFile {
	return {
		...current,
		name: updates.name ?? current.name,
		description: updates.description ?? current.description,
		services: upsertXmtpService(current.services, agentAddress),
		trustedAgentProtocol: {
			...current.trustedAgentProtocol,
			agentAddress,
			capabilities: updates.capabilities ?? current.trustedAgentProtocol.capabilities,
			execution: execution ?? current.trustedAgentProtocol.execution,
		},
	};
}

function buildExecutionMetadata(
	preview: Awaited<ReturnType<typeof getExecutionPreview>>,
): RegistrationFileExecution {
	return {
		mode: preview.mode,
		address: preview.executionAddress,
		paymaster: preview.paymasterProvider,
	};
}

function emitExecutionWarnings(
	preview: Pick<Awaited<ReturnType<typeof getExecutionPreview>>, "warnings">,
	opts: GlobalOptions,
): void {
	for (const warning of preview.warnings) {
		verbose(warning, opts);
	}
}

function extractRegisteredAgentId(
	receipt: Awaited<ReturnType<typeof executeContractCalls>>["transactionReceipt"],
	registryAddress: `0x${string}`,
): number {
	const transferLog = (receipt.logs ?? []).find(
		(log) =>
			log.address.toLowerCase() === registryAddress.toLowerCase() &&
			log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
	);

	if (!transferLog?.topics[3]) {
		throw new Error(
			"Transfer event not found in registration transaction receipt. " +
				"The transaction may have succeeded on-chain — check the registry with `tap identity resolve-self`.",
		);
	}

	return Number(BigInt(transferLog.topics[3]));
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => canonicalizeJson(item));
	}

	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entryValue]) => entryValue !== undefined)
				.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
				.map(([key, entryValue]) => [key, canonicalizeJson(entryValue)]),
		);
	}

	return value;
}

/** Deterministic JSON serialization for content comparison. */
function canonicalJson(obj: unknown): string {
	return JSON.stringify(canonicalizeJson(obj));
}

/** SHA-256 hash of the canonical JSON representation. */
function contentHash(registrationFile: RegistrationFile): string {
	return createHash("sha256").update(canonicalJson(registrationFile)).digest("hex");
}

function hasSameRegistrationContent(left: RegistrationFile, right: RegistrationFile): boolean {
	return contentHash(left) === contentHash(right);
}

function isFullManifestReplacement(cmdOpts: RegisterUpdateOptions): boolean {
	return (
		cmdOpts.name !== undefined &&
		cmdOpts.description !== undefined &&
		cmdOpts.capabilities !== undefined
	);
}

function emitNoChangeResult(
	agentId: number,
	agentURI: string,
	opts: GlobalOptions,
	startTime: number,
): void {
	success(
		{
			agent_id: agentId,
			agent_uri: agentURI,
			updated: false,
			no_change: true,
		},
		opts,
		startTime,
	);
}

interface IpfsCache {
	[contentHash: string]: { cid: string; uri: string };
}

const BASE_MAINNET_CAIP2 = "eip155:8453";
const X402_UPLOAD_BUFFER_USDC = 10_000n;
const X402_TOP_UP_GAS_RESERVE_USDC = 10_000n;

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

async function ensureX402UploadFunding(
	config: TrustedAgentsConfig,
	signingProvider: SigningProvider,
	opts: GlobalOptions,
): Promise<void> {
	const baseChainConfig = config.chains[BASE_MAINNET_CAIP2];
	if (!baseChainConfig) {
		throw new Error("Base mainnet chain config is required for x402 uploads");
	}

	const usdc = getUsdcAsset(BASE_MAINNET_CAIP2);
	if (!usdc) {
		throw new Error("Base mainnet USDC asset config is missing");
	}

	const publicClient = buildPublicClient(baseChainConfig);
	const messagingAddress = await signingProvider.getAddress();
	const messagingBalance = (await publicClient.readContract({
		address: usdc.address,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [messagingAddress],
	})) as bigint;

	if (messagingBalance >= X402_UPLOAD_BUFFER_USDC) {
		return;
	}

	const baseExecution = await getExecutionPreview(config, baseChainConfig, signingProvider, {
		requireProvider: true,
	});
	for (const warning of baseExecution.warnings) {
		verbose(warning, opts);
	}

	const shortfall = X402_UPLOAD_BUFFER_USDC - messagingBalance;
	if (baseExecution.executionAddress.toLowerCase() === messagingAddress.toLowerCase()) {
		throw new Error(
			`x402 upload needs Base mainnet USDC on ${messagingAddress}. Fund at least ${formatUnits(X402_UPLOAD_BUFFER_USDC, usdc.decimals)} ${usdc.symbol} on Base mainnet.`,
		);
	}

	const executionBalance = (await publicClient.readContract({
		address: usdc.address,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [baseExecution.executionAddress],
	})) as bigint;
	const minimumExecutionBalance = shortfall + X402_TOP_UP_GAS_RESERVE_USDC;
	if (executionBalance < minimumExecutionBalance) {
		throw new Error(
			`x402 upload needs Base mainnet USDC on execution account ${baseExecution.executionAddress}. Fund at least ${formatUnits(minimumExecutionBalance, usdc.decimals)} ${usdc.symbol} on Base mainnet or use --pinata-jwt.`,
		);
	}

	info(
		`Funding messaging identity ${messagingAddress} from Base execution account ${baseExecution.executionAddress} for x402 upload...`,
		opts,
	);
	const topUpResult = await executeContractCalls(
		config,
		baseChainConfig,
		signingProvider,
		[
			{
				to: usdc.address,
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "transfer",
					args: [messagingAddress, shortfall],
				}),
			},
		],
		{
			preview: baseExecution,
		},
	);
	for (const warning of topUpResult.warnings) {
		verbose(warning, opts);
	}
	info(
		`Funded messaging identity with ${formatUnits(shortfall, usdc.decimals)} ${usdc.symbol} on Base mainnet.`,
		opts,
	);
}

function shouldDeployExecutionAccountBeforeUpload(params: {
	config: TrustedAgentsConfig;
	uri?: string;
	pinataJwt?: string;
	ipfsProvider?: string;
}): boolean {
	if (params.uri) {
		return false;
	}

	try {
		return (
			resolveEffectiveIpfsProvider({
				chain: params.config.chain,
				configuredProvider: params.ipfsProvider ?? params.config.ipfs?.provider,
				pinataJwt: resolvePinataJwt(params.pinataJwt),
			}) === "tack"
		);
	} catch {
		return false;
	}
}

/**
 * Resolve URI for registration metadata.
 *
 * Priority: --uri (skip upload) > cached CID > selected provider
 *
 * Provider resolution:
 * - `--ipfs-provider` flag
 * - `config.yaml` `ipfs.provider`
 * - `auto` fallback: Taiko → tack, Pinata JWT present → pinata, else → x402
 */
async function resolveAgentURI(
	params: {
		registrationFile?: RegistrationFile;
		config: TrustedAgentsConfig;
		signingProvider: SigningProvider;
		executionPreview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
		dataDir: string;
		uri?: string;
		pinataJwt?: string;
		ipfsProvider?: string;
		nameHint: string;
	},
	opts: GlobalOptions,
): Promise<{ agentURI: string; ipfsCid?: string } | null> {
	// 1. Explicit URI — no upload needed
	if (params.uri) {
		info(`Using provided URI: ${params.uri}`, opts);
		return { agentURI: params.uri };
	}

	if (!params.registrationFile) {
		throw new Error("registrationFile is required when URI is not provided");
	}

	// 2. Check IPFS cache — skip upload if identical content was previously uploaded
	const hash = contentHash(params.registrationFile);
	const cache = await loadIpfsCache(params.dataDir);
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

	let effectiveProvider: Exclude<IpfsUploadProvider, "auto">;
	try {
		effectiveProvider = resolveEffectiveIpfsProvider({
			chain: params.config.chain,
			configuredProvider: params.ipfsProvider ?? params.config.ipfs?.provider,
			pinataJwt: resolvePinataJwt(params.pinataJwt),
		});
	} catch (err) {
		error("VALIDATION_ERROR", err instanceof Error ? err.message : String(err), opts);
		return null;
	}
	const jwt = resolvePinataJwt(params.pinataJwt);

	// 3. x402 via Pinata endpoint (Base mainnet USDC)
	if (effectiveProvider === "x402") {
		info(
			"Uploading registration file to IPFS via x402 (paying with USDC on Base mainnet)...",
			opts,
		);
		try {
			await ensureX402UploadFunding(params.config, params.signingProvider, opts);
			const ipfs = await uploadToIpfsX402(params.registrationFile, params.signingProvider);
			info(`Uploaded to IPFS: ${ipfs.uri}`, opts);
			cache[hash] = { cid: ipfs.cid, uri: ipfs.uri };
			await saveIpfsCache(params.dataDir, cache);
			return { agentURI: ipfs.uri, ipfsCid: ipfs.cid };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			verbose(`x402 upload failed: ${msg}`, opts);
			error(
				"UPLOAD_ERROR",
				`IPFS upload via x402 failed: ${msg}

x402 requires USDC on Base mainnet (not testnet) to pay for IPFS pinning.
Send USDC to your messaging identity / EOA on Base (chain ID 8453).

Alternatives:
  --ipfs-provider tack   Use Tack x402 upload on Taiko instead
  --pinata-jwt <token>  Use a Pinata API key instead (works on any chain)
  --uri <url>           Skip IPFS upload with a pre-hosted registration file`,
				opts,
			);
			return null;
		}
	}

	// 4. x402 via Tack endpoint (Taiko mainnet USDC)
	if (effectiveProvider === "tack") {
		info(
			"Uploading registration file to IPFS via Tack x402 (paying with USDC on Taiko mainnet)...",
			opts,
		);
		try {
			const ipfs = await uploadToIpfsTack(
				params.registrationFile,
				params.config,
				params.signingProvider,
				{
					apiUrl: resolveTackApiUrl(params.config.ipfs?.tackApiUrl),
					preview: params.executionPreview,
				},
			);
			info(`Uploaded to IPFS: ${ipfs.uri}`, opts);
			cache[hash] = { cid: ipfs.cid, uri: ipfs.uri };
			await saveIpfsCache(params.dataDir, cache);
			return { agentURI: ipfs.uri, ipfsCid: ipfs.cid };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error(
				"UPLOAD_ERROR",
				`IPFS upload via Tack failed: ${msg}

Tack x402 uploads require USDC on Taiko mainnet (chain ID 167000).

Alternatives:
  --ipfs-provider x402  Use Pinata x402 on Base mainnet
  --pinata-jwt <token>  Use Pinata API upload
  --uri <url>           Skip IPFS upload with a pre-hosted registration file`,
				opts,
			);
			return null;
		}
	}

	// 5. Pinata JWT (authenticated API)
	if (!jwt) {
		error(
			"VALIDATION_ERROR",
			"Pinata provider selected but no JWT was provided. Set TAP_PINATA_JWT or pass --pinata-jwt.",
			opts,
		);
		return null;
	}

	info("Uploading registration file to IPFS via Pinata...", opts);
	const ipfs = await uploadToIpfsPinata(params.registrationFile, jwt, `tap-${params.nameHint}`);
	info(`Uploaded to IPFS: ${ipfs.uri}`, opts);
	cache[hash] = { cid: ipfs.cid, uri: ipfs.uri };
	await saveIpfsCache(params.dataDir, cache);
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

		const signingProvider = new OwsSigningProvider(
			config.ows.wallet,
			config.chain,
			config.ows.apiKey,
		);
		const agentAddress = await signingProvider.getAddress();
		const executionPreview = await getExecutionPreview(config, chainConfig, signingProvider, {
			requireProvider: true,
		});
		emitExecutionWarnings(executionPreview, opts);
		const publicClient = buildPublicClient(chainConfig);
		const registry = new ERC8004Registry(publicClient, chainConfig.registryAddress);

		await registry.verifyDeployed();
		await ensureExecutionReady(config, chainConfig, signingProvider, {
			preview: executionPreview,
			deployEip4337Account:
				executionPreview.mode === "eip4337" &&
				shouldDeployExecutionAccountBeforeUpload({
					config,
					uri: cmdOpts.uri,
					pinataJwt: cmdOpts.pinataJwt,
					ipfsProvider: cmdOpts.ipfsProvider,
				}),
		});

		// Build registration file
		const registrationFile = buildRegistrationFile(
			cmdOpts.name,
			cmdOpts.description,
			parseCapabilities(cmdOpts.capabilities),
			agentAddress,
			buildExecutionMetadata(executionPreview),
		);

		// Validate before uploading
		validateRegistrationFile(registrationFile);
		verbose("Registration file validated", opts);

		// Upload to IPFS (x402 or Pinata JWT) or use provided URI
		const result = await resolveAgentURI(
			{
				registrationFile,
				config,
				signingProvider,
				executionPreview,
				dataDir: config.dataDir,
				uri: cmdOpts.uri,
				pinataJwt: cmdOpts.pinataJwt,
				ipfsProvider: cmdOpts.ipfsProvider,
				nameHint: cmdOpts.name,
			},
			opts,
		);
		if (!result) {
			process.exitCode = 1;
			return;
		}

		// Register on-chain
		info(`Registering on ${chainConfig.name} (${config.chain})...`, opts);
		const executionResult = await executeContractCalls(
			config,
			chainConfig,
			signingProvider,
			[
				{
					to: chainConfig.registryAddress,
					data: encodeFunctionData({
						abi: ERC8004_ABI,
						functionName: "register",
						args: [result.agentURI],
					}),
				},
			],
			{
				preview: executionPreview,
			},
		);
		emitExecutionWarnings(executionResult, opts);
		const agentId = extractRegisteredAgentId(
			executionResult.transactionReceipt,
			chainConfig.registryAddress,
		);
		info(`Registered! Agent ID: ${agentId}`, opts);

		// Auto-update config.yaml with the new agent_id
		const cfgPath = resolveConfigPath(opts, config.dataDir);
		await updateConfigAgentId(cfgPath, agentId);
		verbose(`Updated ${cfgPath} with agent_id: ${agentId}`, opts);

		const explorerUrl = chainConfig.blockExplorerUrl
			? `${chainConfig.blockExplorerUrl}/address/${chainConfig.registryAddress}`
			: undefined;

		const nextSteps = [
			`Agent #${agentId} is live on ${chainConfig.name}`,
			"Create an invite: tap invite create",
			"Share the link with a peer, who runs: tap connect <url> --yes",
		];

		if (await commandExists("openclaw")) {
			nextSteps.push(buildOpenClawConfigStep(config.dataDir));
		}

		success(
			{
				agent_id: agentId,
				chain: config.chain,
				address: agentAddress,
				messaging_address: executionResult.messagingAddress,
				execution_mode: executionResult.mode,
				execution_address: executionResult.executionAddress,
				funding_address: executionResult.fundingAddress,
				paymaster_provider: executionResult.paymasterProvider,
				gas_payment_mode: executionResult.gasPaymentMode,
				agent_uri: result.agentURI,
				ipfs_cid: result.ipfsCid,
				transaction_hash: executionResult.transactionHash,
				user_operation_hash: executionResult.userOperationHash,
				explorer: explorerUrl,
				next_steps: nextSteps,
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
	cmdOpts: RegisterUpdateOptions,
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

		const signingProvider = new OwsSigningProvider(
			config.ows.wallet,
			config.chain,
			config.ows.apiKey,
		);
		const agentAddress = await signingProvider.getAddress();

		const hasManifestOverrides =
			cmdOpts.name !== undefined ||
			cmdOpts.description !== undefined ||
			cmdOpts.capabilities !== undefined;
		if (cmdOpts.uri && hasManifestOverrides) {
			error(
				"VALIDATION_ERROR",
				"Do not combine --uri with --name/--description/--capabilities. Either provide a full URI or let tap build and upload a new registration file.",
				opts,
			);
			process.exitCode = 2;
			return;
		}

		const publicClient = buildPublicClient(chainConfig);
		const registry = new ERC8004Registry(publicClient, chainConfig.registryAddress);

		await registry.verifyDeployed();
		const existingAgentURI = await registry.getTokenURI(config.agentId);

		if (cmdOpts.uri) {
			if (existingAgentURI === cmdOpts.uri) {
				emitNoChangeResult(config.agentId, cmdOpts.uri, opts, startTime);
				return;
			}

			const executionPreview = await getExecutionPreview(config, chainConfig, signingProvider, {
				requireProvider: true,
			});
			emitExecutionWarnings(executionPreview, opts);
			await ensureExecutionReady(config, chainConfig, signingProvider, {
				preview: executionPreview,
			});
			info(`Updating agent #${config.agentId} URI on ${chainConfig.name}...`, opts);
			const executionResult = await executeContractCalls(
				config,
				chainConfig,
				signingProvider,
				[
					{
						to: chainConfig.registryAddress,
						data: encodeFunctionData({
							abi: ERC8004_ABI,
							functionName: "setAgentURI",
							args: [BigInt(config.agentId), cmdOpts.uri],
						}),
					},
				],
				{
					preview: executionPreview,
				},
			);
			emitExecutionWarnings(executionResult, opts);

			const uriNextSteps: string[] = [];
			if (await commandExists("openclaw")) {
				uriNextSteps.push(buildOpenClawConfigStep(config.dataDir));
			}

			success(
				{
					agent_id: config.agentId,
					agent_uri: cmdOpts.uri,
					execution_mode: executionResult.mode,
					execution_address: executionResult.executionAddress,
					gas_payment_mode: executionResult.gasPaymentMode,
					transaction_hash: executionResult.transactionHash,
					user_operation_hash: executionResult.userOperationHash,
					updated: true,
					...(uriNextSteps.length > 0 ? { next_steps: uriNextSteps } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		const fullReplacement = isFullManifestReplacement(cmdOpts);
		let currentRegistrationFile: RegistrationFile | null = null;
		let pendingRegistrationFile: RegistrationFile;

		if (fullReplacement) {
			try {
				currentRegistrationFile = await fetchRegistrationFile(existingAgentURI);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				verbose(
					`Current registration could not be fetched; proceeding with replacement upload: ${message}`,
					opts,
				);
			}

			pendingRegistrationFile = buildRegistrationFile(
				cmdOpts.name!,
				cmdOpts.description!,
				parseCapabilities(cmdOpts.capabilities!),
				agentAddress,
				currentRegistrationFile?.trustedAgentProtocol.execution,
			);
			validateRegistrationFile(pendingRegistrationFile);
			verbose("Replacement registration file validated", opts);
		} else {
			info(`Fetching current registration for agent #${config.agentId}...`, opts);
			currentRegistrationFile = await fetchRegistrationFile(existingAgentURI);

			pendingRegistrationFile = buildUpdatedRegistrationFile(
				currentRegistrationFile,
				agentAddress,
				currentRegistrationFile.trustedAgentProtocol.execution,
				{
					name: cmdOpts.name,
					description: cmdOpts.description,
					capabilities:
						cmdOpts.capabilities !== undefined
							? parseCapabilities(cmdOpts.capabilities)
							: undefined,
				},
			);
			validateRegistrationFile(pendingRegistrationFile);
			verbose("Updated registration file validated", opts);
		}

		if (
			currentRegistrationFile &&
			hasSameRegistrationContent(currentRegistrationFile, pendingRegistrationFile)
		) {
			emitNoChangeResult(config.agentId, existingAgentURI, opts, startTime);
			return;
		}

		const executionPreview = await getExecutionPreview(config, chainConfig, signingProvider, {
			requireProvider: true,
		});
		emitExecutionWarnings(executionPreview, opts);
		await ensureExecutionReady(config, chainConfig, signingProvider, {
			preview: executionPreview,
			deployEip4337Account:
				executionPreview.mode === "eip4337" &&
				shouldDeployExecutionAccountBeforeUpload({
					config,
					pinataJwt: cmdOpts.pinataJwt,
					ipfsProvider: cmdOpts.ipfsProvider,
				}),
		});

		const registrationFile = fullReplacement
			? buildRegistrationFile(
					cmdOpts.name!,
					cmdOpts.description!,
					parseCapabilities(cmdOpts.capabilities!),
					agentAddress,
					buildExecutionMetadata(executionPreview),
				)
			: buildUpdatedRegistrationFile(
					currentRegistrationFile!,
					agentAddress,
					buildExecutionMetadata(executionPreview),
					{
						name: cmdOpts.name,
						description: cmdOpts.description,
						capabilities:
							cmdOpts.capabilities !== undefined
								? parseCapabilities(cmdOpts.capabilities)
								: undefined,
					},
				);
		validateRegistrationFile(registrationFile);

		const result = await resolveAgentURI(
			{
				registrationFile,
				config,
				signingProvider,
				executionPreview,
				dataDir: config.dataDir,
				pinataJwt: cmdOpts.pinataJwt,
				ipfsProvider: cmdOpts.ipfsProvider,
				nameHint: registrationFile.name,
			},
			opts,
		);
		if (!result) {
			process.exitCode = 1;
			return;
		}

		// Update on-chain
		info(`Updating agent #${config.agentId} URI on ${chainConfig.name}...`, opts);
		if (existingAgentURI === result.agentURI) {
			emitNoChangeResult(config.agentId, result.agentURI, opts, startTime);
			return;
		}
		const executionResult = await executeContractCalls(
			config,
			chainConfig,
			signingProvider,
			[
				{
					to: chainConfig.registryAddress,
					data: encodeFunctionData({
						abi: ERC8004_ABI,
						functionName: "setAgentURI",
						args: [BigInt(config.agentId), result.agentURI],
					}),
				},
			],
			{
				preview: executionPreview,
			},
		);
		for (const warning of executionResult.warnings) {
			verbose(warning, opts);
		}

		const updateNextSteps: string[] = [];
		if (await commandExists("openclaw")) {
			updateNextSteps.push(buildOpenClawConfigStep(config.dataDir));
		}

		success(
			{
				agent_id: config.agentId,
				agent_uri: result.agentURI,
				ipfs_cid: result.ipfsCid,
				execution_mode: executionResult.mode,
				execution_address: executionResult.executionAddress,
				gas_payment_mode: executionResult.gasPaymentMode,
				transaction_hash: executionResult.transactionHash,
				user_operation_hash: executionResult.userOperationHash,
				updated: true,
				...(updateNextSteps.length > 0 ? { next_steps: updateNextSteps } : {}),
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
