import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type OpenWalletConfig,
	deriveOpenWalletXmtpDbEncryptionKey,
	derivePrivateKeyXmtpDbEncryptionKey,
	ensureOpenWallet,
} from "trusted-agents-core";
import YAML from "yaml";
import { ALL_CHAINS, DEFAULT_CHAIN_ALIAS, resolveChainAlias } from "../lib/chains.js";
import {
	getDefaultExecutionModeForChain,
	getDefaultPaymasterProviderForMode,
	resolveConfigPath,
	resolveDataDir,
} from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

interface StoredYamlConfig {
	agent_id?: number;
	chain?: string;
	execution?: {
		mode?: string;
		paymaster_provider?: string;
	};
	xmtp?: {
		env?: "dev" | "production" | "local";
		db_encryption_key?: string;
	};
	chains?: Record<string, Record<string, string>>;
	wallet?: {
		provider?: string;
		id?: string;
		name?: string;
		vault_path?: string;
	};
}

export interface InitOptions {
	privateKey?: string;
	chain?: string;
	wallet?: string;
}

export async function initCommand(opts: GlobalOptions, cmdOpts?: InitOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);

		if (existsSync(configPath)) {
			info(`Config already exists at ${configPath}. Reusing and updating wallet settings.`, opts);
		}

		await mkdir(`${dataDir}/conversations`, { recursive: true });
		await mkdir(`${dataDir}/xmtp`, { recursive: true });

		const existingConfig = existsSync(configPath)
			? ((YAML.parse(await readFile(configPath, "utf-8")) as StoredYamlConfig | null) ?? undefined)
			: undefined;

		const existingWallet = resolveStoredWallet(existingConfig?.wallet);
		const walletResult = ensureOpenWallet({
			dataDir,
			privateKey: normalizePrivateKeyOption(cmdOpts?.privateKey),
			walletName: cmdOpts?.wallet,
			existingWallet: cmdOpts?.privateKey || cmdOpts?.wallet ? undefined : existingWallet,
		});

		emitWalletSelectionInfo(walletResult.status, walletResult.wallet, opts);

		const chain = resolveChainAlias(existingConfig?.chain ?? cmdOpts?.chain ?? DEFAULT_CHAIN_ALIAS);
		const chainConfig = ALL_CHAINS[chain];
		const chainLabel = chainConfig?.name ?? chain;
		const isTestnet = chain !== "eip155:8453" && chain !== "eip155:167000";
		const xmtpEnv = isTestnet ? "dev" : "production";
		const executionMode = getDefaultExecutionModeForChain(chain);
		const paymasterProvider = getDefaultPaymasterProviderForMode(executionMode);
		const selectedXmtpDbEncryptionKey = cmdOpts?.privateKey
			? derivePrivateKeyXmtpDbEncryptionKey(normalizePrivateKeyOption(cmdOpts.privateKey)!)
			: deriveOpenWalletXmtpDbEncryptionKey(walletResult.wallet);

		const existingWalletLookup = existingWallet?.id ?? existingWallet?.name;
		const selectedWalletLookup = walletResult.wallet.id ?? walletResult.wallet.name;
		const shouldRefreshXmtpKey =
			existingWalletLookup === undefined || existingWalletLookup !== selectedWalletLookup;

		const chainsYaml: Record<string, Record<string, string>> = {
			...(existingConfig?.chains ?? {}),
		};
		if (chainConfig && !["eip155:8453", "eip155:84532"].includes(chain)) {
			chainsYaml[chain] = {
				rpc_url: chainConfig.rpcUrl,
				registry_address: chainConfig.registryAddress,
			};
		}

		const yamlConfig: Record<string, unknown> = {
			...(existingConfig ?? {}),
			agent_id: existingConfig?.agent_id ?? -1,
			chain,
			wallet: {
				provider: "open-wallet",
				name: walletResult.wallet.name,
				...(walletResult.wallet.id ? { id: walletResult.wallet.id } : {}),
				...(walletResult.wallet.vaultPath ? { vault_path: walletResult.wallet.vaultPath } : {}),
			},
			execution: {
				mode: executionMode,
				...(paymasterProvider ? { paymaster_provider: paymasterProvider } : {}),
			},
			xmtp: {
				env: xmtpEnv,
				db_encryption_key:
					shouldRefreshXmtpKey || !existingConfig?.xmtp?.db_encryption_key
						? selectedXmtpDbEncryptionKey
						: existingConfig.xmtp.db_encryption_key,
			},
		};
		if (Object.keys(chainsYaml).length > 0) {
			yamlConfig.chains = chainsYaml;
		}

		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");
		info(`Saved config at ${configPath}`, opts);

		const fundingSteps =
			executionMode === "eip7702"
				? chain === "eip155:8453"
					? [
							`Agent address: ${walletResult.address}`,
							"Base defaults to EIP-7702 with Circle Paymaster.",
							"Fund this same address with Base mainnet USDC.",
							"That single Base mainnet USDC balance covers registration gas and x402 IPFS uploads.",
						]
					: [
							`Agent address: ${walletResult.address}`,
							"Base Sepolia defaults to EIP-7702 with Circle Paymaster.",
							"Fund this address with Base Sepolia USDC for registration transactions.",
							"IPFS uploads auto-select based on chain (Tack on Taiko, Pinata x402 on Base). Override with --ipfs-provider or --pinata-jwt.",
						]
				: executionMode === "eip4337"
					? [
							`Agent owner address: ${walletResult.address}`,
							`${chainLabel} defaults to EIP-4337 with Servo Paymaster.`,
							"Fund the Servo execution account with USDC (run `tap balance --json` to see `execution_address`).",
							"`tap register` deploys the Servo execution account before the Tack upload on Taiko.",
							"IPFS uploads auto-select based on chain (Tack on Taiko, Pinata x402 on Base). Override with --ipfs-provider or --pinata-jwt.",
						]
					: [
							`Agent address: ${walletResult.address}`,
							`${chainLabel} currently uses direct EOA transactions in this CLI.`,
							`Fund this address with native gas on ${chainLabel}.`,
							"IPFS uploads auto-select based on chain (Tack on Taiko, Pinata x402 on Base). Override with --ipfs-provider or --pinata-jwt.",
						];

		success(
			{
				address: walletResult.address,
				chain,
				chain_name: chainLabel,
				wallet_provider: "open-wallet",
				wallet_name: walletResult.wallet.name,
				wallet_id: walletResult.wallet.id,
				wallet_status: walletResult.status,
				config: configPath,
				data_dir: dataDir,
				next_steps: [
					...fundingSteps,
					`Register: tap register --name "MyAgent" --description "..." --capabilities "chat"`,
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

function normalizePrivateKeyOption(value: string | undefined): `0x${string}` | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.startsWith("0x") ? value : `0x${value}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
		throw new Error("Invalid private key: expected 64-char hex string");
	}

	return normalized as `0x${string}`;
}

function resolveStoredWallet(
	wallet: StoredYamlConfig["wallet"] | undefined,
): OpenWalletConfig | undefined {
	if (!wallet || wallet.provider !== "open-wallet" || !wallet.name) {
		return undefined;
	}

	return {
		provider: "open-wallet",
		name: wallet.name,
		...(wallet.id ? { id: wallet.id } : {}),
		...(wallet.vault_path ? { vaultPath: wallet.vault_path } : {}),
	};
}

function emitWalletSelectionInfo(
	status: string,
	wallet: OpenWalletConfig,
	opts: GlobalOptions,
): void {
	const label = wallet.id ? `${wallet.name} (${wallet.id})` : wallet.name;
	switch (status) {
		case "existing-config":
			info(`Reusing configured Open Wallet wallet ${label}`, opts);
			return;
		case "reused-single-existing":
			info(`Reusing the only available Open Wallet wallet ${label}`, opts);
			return;
		case "reused-by-name":
			info(`Reusing Open Wallet wallet ${label}`, opts);
			return;
		case "reused-by-address":
			info(`Matched existing Open Wallet wallet ${label} by address`, opts);
			return;
		case "imported":
			info(`Imported the provided private key into Open Wallet wallet ${label}`, opts);
			return;
		default:
			info(`Created Open Wallet wallet ${label}`, opts);
	}
}
