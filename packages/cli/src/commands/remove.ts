import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ChainConfig,
	type TransportOwnerInfo,
	TransportOwnerLock,
	type TrustedAgentsConfig,
	ValidationError,
	isProcessAlive,
	loadTrustedAgentConfigFromDataDir,
	resolveDataDir as resolveAbsoluteDataDir,
} from "trusted-agents-core";
import { createSigningProviderViemAccount } from "trusted-agents-core";
import { formatUnits, isAddress } from "viem";
import YAML from "yaml";
import { ALL_CHAINS, resolveChainAlias } from "../lib/chains.js";
import { resolveDataDir as resolveCliDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { promptInput, promptYesNo } from "../lib/prompt.js";
import {
	createConfiguredSigningProvider,
	getLegacyWalletMigrationWarning,
} from "../lib/wallet-config.js";
import { buildPublicClient, buildWalletClient } from "../lib/wallet.js";
import type { GlobalOptions } from "../types.js";

export interface RemoveOptions {
	dryRun?: boolean;
	unsafeWipeDataDir?: boolean;
	yes?: boolean;
}

interface RemoveStoredConfig {
	agent_id?: number;
}

interface DataDirInspection {
	hasManagedEntries: boolean;
	managedEntries: string[];
	unexpectedEntries: string[];
}

export interface RemoveBalanceContext {
	config: TrustedAgentsConfig;
	chain: string;
	chainConfig: ChainConfig;
	address: `0x${string}`;
	nativeBalanceWei: bigint;
	nativeBalanceEth: string;
}

export interface RemoveBalanceProbe {
	checked: boolean;
	chain: string | null;
	chain_name: string | null;
	address: string | null;
	native_balance_wei: string | null;
	native_balance_eth: string | null;
	warning?: string;
}

export interface RemoveBalanceProbeResult {
	context: RemoveBalanceContext | null;
	probe: RemoveBalanceProbe;
}

interface RemoveTransferResult {
	txHash: `0x${string}`;
	amountWei: bigint;
	gasReserveWei: bigint;
}

export interface RemoveFundsTransferOutcome {
	attempted: boolean;
	skipped_reason?: string;
	to_address?: string;
	amount_wei?: string;
	amount_eth?: string;
	gas_reserve_wei?: string;
	tx_hash?: string;
}

export interface RemovePlan {
	dataDir: string;
	configPath: string;
	agentId: number | null;
	address: string | null;
	pathsToRemove: string[];
	warnings: string[];
	liveTransportOwner: TransportOwnerInfo | null;
	blockingReasons: string[];
}

const TAP_DATA_DIR_ENTRIES = new Set([
	".transport.lock",
	"config.yaml",
	"contacts.json",
	"conversations",
	"identity",
	"ipfs-cache.json",
	"notes",
	"pending-connects.json",
	"pending-invites.json",
	"request-journal.json",
	"xmtp",
]);

export async function removeCommand(cmdOpts: RemoveOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const interactive = isInteractiveSession();
		const plan = await buildRemovePlan(opts);
		const warnings = [...plan.warnings];
		const balanceProbe =
			interactive && !cmdOpts.dryRun
				? await removeRuntime.probeRemoveNativeBalance(plan.dataDir, plan.configPath)
				: skippedBalanceProbe(
						cmdOpts.dryRun
							? "On-chain balance check skipped during dry-run."
							: "On-chain balance check skipped in non-interactive mode.",
					);
		if (balanceProbe.probe.warning) {
			warnings.push(balanceProbe.probe.warning);
		}

		if (cmdOpts.dryRun) {
			success(
				{
					dry_run: true,
					data_dir: plan.dataDir,
					config_path: plan.configPath,
					agent_id: plan.agentId,
					address: plan.address,
					paths_to_remove: plan.pathsToRemove,
					live_transport_owner: plan.liveTransportOwner,
					blocking_reasons: plan.blockingReasons,
					balance_check: balanceProbe.probe,
					can_remove:
						plan.liveTransportOwner === null &&
						plan.blockingReasons.length === 0 &&
						plan.pathsToRemove.length > 0,
					warnings,
				},
				opts,
				startTime,
			);
			return;
		}

		if (!cmdOpts.unsafeWipeDataDir) {
			error(
				"VALIDATION_ERROR",
				"Refusing to remove local TAP data without --unsafe-wipe-data-dir. Use --dry-run to inspect what would be removed.",
				opts,
			);
			process.exitCode = 2;
			return;
		}

		if (plan.liveTransportOwner) {
			error(
				"TRANSPORT_OWNERSHIP_ERROR",
				`Refusing to remove local TAP data while ${plan.liveTransportOwner.owner} (pid ${plan.liveTransportOwner.pid}) owns the transport for this data dir.`,
				opts,
			);
			process.exitCode = 1;
			return;
		}

		if (plan.blockingReasons.length > 0) {
			error("VALIDATION_ERROR", plan.blockingReasons.join(" "), opts);
			process.exitCode = 2;
			return;
		}

		if (plan.pathsToRemove.length === 0) {
			success(
				{
					removed: false,
					data_dir: plan.dataDir,
					config_path: plan.configPath,
					agent_id: plan.agentId,
					address: plan.address,
					removed_paths: [],
					balance_check: balanceProbe.probe,
					warnings: [...warnings, "No local TAP data was found to remove."],
				},
				opts,
				startTime,
			);
			return;
		}

		if (!interactive && !cmdOpts.yes) {
			error(
				"VALIDATION_ERROR",
				"Non-interactive removal requires both --unsafe-wipe-data-dir and --yes.",
				opts,
			);
			process.exitCode = 2;
			return;
		}

		let fundsTransfer: RemoveFundsTransferOutcome;
		if (interactive) {
			fundsTransfer = await maybeTransferRemainingNativeFunds(balanceProbe);
		} else {
			fundsTransfer = {
				attempted: false,
				skipped_reason: "No interactive transfer step in non-interactive mode.",
			};
		}

		if (interactive) {
			const confirmed = await promptYesNo(
				`Remove local TAP agent data at ${plan.dataDir}? This deletes the entire data dir and cannot be undone. [y/N] `,
			);
			if (!confirmed) {
				success(
					{
						removed: false,
						aborted: true,
						data_dir: plan.dataDir,
						balance_check: balanceProbe.probe,
						funds_transfer: fundsTransfer,
						reason: "Confirmation declined. No local TAP data was removed.",
					},
					opts,
					startTime,
				);
				return;
			}
		}

		await rm(plan.dataDir, { recursive: true, force: true });

		success(
			{
				removed: true,
				data_dir: plan.dataDir,
				config_path: plan.configPath,
				agent_id: plan.agentId,
				address: plan.address,
				removed_paths: plan.pathsToRemove,
				balance_check: balanceProbe.probe,
				funds_transfer: fundsTransfer,
				warnings,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function skippedBalanceProbe(reason: string): RemoveBalanceProbeResult {
	return {
		context: null,
		probe: {
			checked: false,
			chain: null,
			chain_name: null,
			address: null,
			native_balance_wei: null,
			native_balance_eth: null,
			warning: reason,
		},
	};
}

export async function probeRemoveNativeBalance(
	dataDir: string,
	configPath: string,
): Promise<RemoveBalanceProbeResult> {
	try {
		const config = await loadRemoveTargetConfig(dataDir, configPath);
		const chain = config.chain;
		const chainConfig = config.chains[chain];
		if (!chainConfig) {
			return {
				context: null,
				probe: {
					checked: false,
					chain,
					chain_name: null,
					address: null,
					native_balance_wei: null,
					native_balance_eth: null,
					warning: `Could not read on-chain balance because chain ${chain} is not configured.`,
				},
			};
		}

		const signingProvider = createConfiguredSigningProvider(config);
		const address = await signingProvider.getAddress();
		const publicClient = buildPublicClient(chainConfig);
		const nativeBalanceWei = await publicClient.getBalance({ address });
		const context: RemoveBalanceContext = {
			config,
			chain,
			chainConfig,
			address,
			nativeBalanceWei,
			nativeBalanceEth: formatUnits(nativeBalanceWei, 18),
		};

		return {
			context,
			probe: {
				checked: true,
				chain,
				chain_name: chainConfig.name,
				address,
				native_balance_wei: nativeBalanceWei.toString(),
				native_balance_eth: context.nativeBalanceEth,
			},
		};
	} catch (err) {
		return {
			context: null,
			probe: {
				checked: false,
				chain: null,
				chain_name: null,
				address: null,
				native_balance_wei: null,
				native_balance_eth: null,
				warning: `On-chain balance check skipped: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}
}

export async function transferRemainingNativeBalance(
	balanceContext: RemoveBalanceContext,
	toAddress: `0x${string}`,
): Promise<RemoveTransferResult> {
	const signingProvider = createConfiguredSigningProvider(
		balanceContext.config,
		balanceContext.chainConfig.caip2,
	);
	const account = await createSigningProviderViemAccount(signingProvider);
	const publicClient = buildPublicClient(balanceContext.chainConfig);
	const walletClient = buildWalletClient(account, balanceContext.chainConfig);
	const currentBalanceWei = await publicClient.getBalance({ address: account.address });
	const currentBalanceEth = formatUnits(currentBalanceWei, 18);
	const gasEstimate = await publicClient.estimateGas({
		account: account.address,
		to: toAddress,
		value: 0n,
		data: "0x",
	});
	const fees = await publicClient.estimateFeesPerGas();
	const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
	if (gasPrice === undefined) {
		throw new Error("Could not estimate gas price for the native transfer.");
	}
	const gasReserveWei = gasEstimate * gasPrice;
	if (currentBalanceWei <= gasReserveWei) {
		throw new ValidationError(
			`Current balance ${currentBalanceEth} ETH is not enough to cover transfer gas.`,
		);
	}

	const amountWei = currentBalanceWei - gasReserveWei;
	const txRequest: Parameters<typeof walletClient.sendTransaction>[0] = {
		account,
		chain: walletClient.chain,
		to: toAddress,
		value: amountWei,
		gas: gasEstimate,
		data: "0x",
	};
	if (fees.maxFeePerGas !== undefined) {
		txRequest.maxFeePerGas = fees.maxFeePerGas;
		if (fees.maxPriorityFeePerGas !== undefined) {
			txRequest.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
		}
	} else if (fees.gasPrice !== undefined) {
		txRequest.gasPrice = fees.gasPrice;
	}

	const txHash = await walletClient.sendTransaction(txRequest);
	const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
	if (receipt.status === "reverted") {
		throw new Error(
			`Transfer transaction ${txHash} reverted on ${balanceContext.chainConfig.name}.`,
		);
	}

	return {
		txHash,
		amountWei,
		gasReserveWei,
	};
}

async function maybeTransferRemainingNativeFunds(
	balanceProbe: RemoveBalanceProbeResult,
): Promise<RemoveFundsTransferOutcome> {
	const balanceContext = balanceProbe.context;
	if (!balanceContext) {
		return {
			attempted: false,
			skipped_reason: "On-chain balance unavailable; skipped optional funds transfer.",
		};
	}
	if (balanceContext.nativeBalanceWei === 0n) {
		return {
			attempted: false,
			skipped_reason: "No native balance to transfer before removal.",
		};
	}

	const transferPrompt = await promptYesNo(
		`Current ${balanceContext.chainConfig.name} balance for ${balanceContext.address}: ${balanceContext.nativeBalanceEth} ETH. Send remaining funds to another address before local wipe? [y/N] `,
	);
	if (!transferPrompt) {
		return {
			attempted: false,
			skipped_reason: "Operator declined optional funds transfer.",
		};
	}

	const destinationInput = await promptInput("Destination EVM address for remaining funds: ");
	if (!destinationInput) {
		throw new ValidationError("Destination address is required to transfer remaining funds.");
	}
	if (!isAddress(destinationInput)) {
		throw new ValidationError(`Invalid destination address: ${destinationInput}`);
	}
	const toAddress = destinationInput as `0x${string}`;
	if (toAddress.toLowerCase() === balanceContext.address.toLowerCase()) {
		throw new ValidationError("Destination address must differ from the current agent address.");
	}

	const transfer = await removeRuntime.transferRemainingNativeBalance(balanceContext, toAddress);
	return {
		attempted: true,
		to_address: toAddress,
		amount_wei: transfer.amountWei.toString(),
		amount_eth: formatUnits(transfer.amountWei, 18),
		gas_reserve_wei: transfer.gasReserveWei.toString(),
		tx_hash: transfer.txHash,
	};
}

export const removeRuntime = {
	probeRemoveNativeBalance,
	transferRemainingNativeBalance,
};

async function loadRemoveTargetConfig(
	dataDir: string,
	configPath: string,
): Promise<TrustedAgentsConfig> {
	const config = await loadTrustedAgentConfigFromDataDir(dataDir, {
		requireAgentId: false,
		configPath,
		extraChains: ALL_CHAINS,
	});
	const normalizedChain = resolveChainAlias(config.chain);
	return normalizedChain === config.chain ? config : { ...config, chain: normalizedChain };
}

export async function buildRemovePlan(opts: GlobalOptions): Promise<RemovePlan> {
	const dataDir = await resolveRemoveDataDir(opts);
	const configPath = resolveRemoveConfigPath(opts, dataDir);
	const warnings = [
		"This only removes local TAP agent data. It does not unregister the ERC-8004 agent or notify peers.",
		"Host runtime config that still points at this data dir is not updated automatically, including OpenClaw plugin identity settings.",
	];
	const blockingReasons: string[] = [];
	const [agentId, configWarning] = await readAgentId(configPath);
	const [address, keyWarning] = await readAgentAddress(dataDir);
	const liveTransportOwner = await inspectLiveTransportOwner(dataDir);
	const inspection = await inspectDataDir(dataDir);

	if (configWarning) {
		warnings.push(configWarning);
	}
	if (keyWarning) {
		warnings.push(keyWarning);
	}
	if (liveTransportOwner) {
		warnings.push(
			`Removal is currently blocked because ${liveTransportOwner.owner} (pid ${liveTransportOwner.pid}) owns the TAP transport for this data dir.`,
		);
	}
	if (dataDir === resolve("/")) {
		blockingReasons.push("Refusing to remove /. Use a TAP agent data dir instead.");
	}
	if (dataDir === resolve(homedir())) {
		blockingReasons.push(
			"Refusing to remove the current home directory. Use a TAP agent data dir instead.",
		);
	}
	if (inspection.unexpectedEntries.length > 0) {
		const listedEntries = inspection.unexpectedEntries.map((entry) => `"${entry}"`).join(", ");
		const message = `Refusing to remove ${dataDir} because it contains non-TAP top-level entries: ${listedEntries}.`;
		blockingReasons.push(message);
		warnings.push(`${message} TAP remove only wipes TAP-owned data dirs.`);
	}

	return {
		dataDir,
		configPath,
		agentId,
		address,
		pathsToRemove: await collectPlannedRemovalPaths(dataDir, inspection),
		warnings,
		liveTransportOwner,
		blockingReasons,
	};
}

async function resolveRemoveDataDir(opts: GlobalOptions): Promise<string> {
	const configuredPath = resolveAbsoluteDataDir(resolveCliDataDir(opts));
	try {
		return await realpath(configuredPath);
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return configuredPath;
		}
		throw error;
	}
}

function resolveRemoveConfigPath(opts: GlobalOptions, dataDir: string): string {
	const configPath = join(dataDir, "config.yaml");
	if (!opts.config) {
		return configPath;
	}

	if (resolve(opts.config) !== resolve(configPath)) {
		throw new Error(
			"`tap remove` only supports config.yaml inside the resolved data dir. External config paths are not supported.",
		);
	}

	return configPath;
}

async function readAgentId(configPath: string): Promise<[number | null, string | null]> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = (YAML.parse(raw) as RemoveStoredConfig | null | undefined) ?? undefined;
		if (typeof parsed?.agent_id === "number" && Number.isFinite(parsed.agent_id)) {
			return [parsed.agent_id, null];
		}
		return [null, "config.yaml is present but agent_id could not be read."];
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [null, "config.yaml is missing from the resolved data dir."];
		}
		return [
			null,
			`config.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

async function readAgentAddress(dataDir: string): Promise<[string | null, string | null]> {
	const configPath = join(dataDir, "config.yaml");
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed =
			(YAML.parse(raw) as {
				ows?: { wallet?: string; passphrase?: string };
				chain?: string;
			} | null) ?? undefined;
		if (!parsed?.ows?.wallet) {
			const legacyWarning = getLegacyWalletMigrationWarning({ dataDir, configPath });
			return [null, legacyWarning ?? "OWS wallet config is missing from config.yaml."];
		}
		const chain = parsed.chain ?? "eip155:8453";
		const provider = createConfiguredSigningProvider(
			{
				chain,
				ows: { wallet: parsed.ows.wallet, passphrase: parsed.ows.passphrase ?? "" },
				dataDir,
			},
			chain,
		);
		const address = await provider.getAddress();
		return [address, null];
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [null, "config.yaml is missing from the resolved data dir."];
		}
		return [
			null,
			`Agent address could not be read: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

async function inspectLiveTransportOwner(dataDir: string): Promise<TransportOwnerInfo | null> {
	const lock = new TransportOwnerLock(dataDir, "tap remove");
	const owner = await lock.inspect();
	if (!owner) {
		return null;
	}
	return isProcessAlive(owner.pid) ? owner : null;
}

async function inspectDataDir(dataDir: string): Promise<DataDirInspection> {
	try {
		const entries = await readdir(dataDir);
		const managedEntries = entries.filter((entry) => TAP_DATA_DIR_ENTRIES.has(entry));
		const unexpectedEntries = entries.filter((entry) => !TAP_DATA_DIR_ENTRIES.has(entry));
		return {
			hasManagedEntries: managedEntries.length > 0,
			managedEntries,
			unexpectedEntries,
		};
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return { hasManagedEntries: false, managedEntries: [], unexpectedEntries: [] };
		}
		throw error;
	}
}

async function collectPlannedRemovalPaths(
	dataDir: string,
	inspection: DataDirInspection,
): Promise<string[]> {
	if (!inspection.hasManagedEntries) {
		return [];
	}

	const paths: string[] = [];
	if (inspection.unexpectedEntries.length === 0) {
		paths.push(dataDir);
	}

	for (const entry of inspection.managedEntries.sort((left, right) => left.localeCompare(right))) {
		paths.push(...(await collectRemovalPaths(join(dataDir, entry))));
	}

	return paths;
}

async function collectRemovalPaths(targetPath: string): Promise<string[]> {
	try {
		const stat = await lstat(targetPath);
		const paths = [targetPath];
		if (!stat.isDirectory()) {
			return paths;
		}

		const entries = await readdir(targetPath);
		entries.sort((left, right) => left.localeCompare(right));
		for (const entry of entries) {
			paths.push(...(await collectRemovalPaths(join(targetPath, entry))));
		}
		return paths;
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

function isInteractiveSession(): boolean {
	return Boolean(process.stdin.isTTY);
}
