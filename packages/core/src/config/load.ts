import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import YAML from "yaml";
import { resolveDataDir } from "../common/index.js";
import {
	deriveOpenWalletXmtpDbEncryptionKey,
	derivePrivateKeyXmtpDbEncryptionKey,
	ensureOpenWallet,
	resolveAccountFromOpenWallet,
} from "../wallet/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import type {
	ChainConfig,
	ExecutionMode,
	ExecutionPaymasterProvider,
	IpfsUploadProvider,
	OpenWalletConfig,
	TrustedAgentsConfig,
} from "./types.js";

const KEYFILE_NAME = "agent.key";

interface StoredYamlConfig {
	agent_id?: number;
	chain?: string;
	execution?: {
		mode?: ExecutionMode;
		paymaster_provider?: ExecutionPaymasterProvider;
	};
	xmtp?: {
		env?: "dev" | "production" | "local";
		db_encryption_key?: string;
	};
	ipfs?: {
		provider?: IpfsUploadProvider;
		tack_api_url?: string;
	};
	wallet?: {
		provider?: string;
		id?: string;
		name?: string;
		vault_path?: string;
	};
	chains?: Record<
		string,
		{
			rpc_url?: string;
			registry_address?: string;
		}
	>;
	invite_expiry_seconds?: number;
}

export interface LoadTrustedAgentConfigOptions {
	requireAgentId?: boolean;
	agentId?: number;
	chain?: string;
	privateKey?: `0x${string}`;
	configPath?: string;
	extraChains?: Record<string, ChainConfig>;
	executionMode?: ExecutionMode;
	paymasterProvider?: ExecutionPaymasterProvider;
	migrateLegacyKeyfile?: boolean;
}

export function resolveTrustedAgentConfigPath(dataDir: string): string {
	return join(resolveDataDir(dataDir), "config.yaml");
}

export function getDefaultExecutionModeForChain(chain: string): ExecutionMode {
	if (["base", "base-sepolia", "eip155:8453", "eip155:84532"].includes(chain)) {
		return "eip7702";
	}

	if (["taiko", "taiko-mainnet", "eip155:167000"].includes(chain)) {
		return "eip4337";
	}

	return "eoa";
}

export function getDefaultPaymasterProviderForMode(
	mode: ExecutionMode,
): ExecutionPaymasterProvider | undefined {
	if (mode === "eoa") {
		return undefined;
	}

	if (mode === "eip4337") {
		return "servo";
	}

	return DEFAULT_CONFIG.execution?.paymasterProvider ?? "circle";
}

export async function loadTrustedAgentConfigFromDataDir(
	dataDir: string,
	options: LoadTrustedAgentConfigOptions = {},
): Promise<TrustedAgentsConfig> {
	const resolvedDataDir = resolveDataDir(dataDir);
	const configPath = options.configPath ?? resolveTrustedAgentConfigPath(resolvedDataDir);
	let yaml = loadYamlConfig(configPath);

	const agentId = options.agentId ?? yaml?.agent_id;
	if (options.requireAgentId ?? true) {
		if (agentId === undefined || Number.isNaN(agentId) || agentId < 0) {
			throw new Error(
				"agent_id is required and must be >= 0. Set it in config.yaml or through the host runtime before using TAP",
			);
		}
	}

	const storedWallet = resolveStoredWalletConfig(yaml?.wallet);
	const legacyKeyfile = await loadLegacyKeyfile(resolvedDataDir);

	let wallet: TrustedAgentsConfig["wallet"];
	let account: TrustedAgentsConfig["account"];
	let xmtpDbEncryptionKey = yaml?.xmtp?.db_encryption_key as `0x${string}` | undefined;

	if (options.privateKey) {
		account = privateKeyToAccount(options.privateKey);
		wallet = { provider: "env-private-key" };
		xmtpDbEncryptionKey ??= derivePrivateKeyXmtpDbEncryptionKey(options.privateKey);
	} else if (storedWallet) {
		account = resolveAccountFromOpenWallet(storedWallet);
		wallet = storedWallet;
		xmtpDbEncryptionKey ??= deriveOpenWalletXmtpDbEncryptionKey(storedWallet);
	} else if (legacyKeyfile) {
		if ((options.migrateLegacyKeyfile ?? true) && existsSync(configPath)) {
			const migration = await migrateLegacyKeyfile({
				dataDir: resolvedDataDir,
				configPath,
				yaml,
				privateKey: legacyKeyfile.privateKey,
			});
			yaml = migration.yaml;
			account = resolveAccountFromOpenWallet(migration.wallet);
			wallet = migration.wallet;
			xmtpDbEncryptionKey ??= migration.xmtpDbEncryptionKey;
		} else {
			account = privateKeyToAccount(legacyKeyfile.privateKey);
			wallet = { provider: "legacy-keyfile", path: legacyKeyfile.path };
			xmtpDbEncryptionKey ??= derivePrivateKeyXmtpDbEncryptionKey(legacyKeyfile.privateKey);
		}
	} else {
		throw new Error(
			`No wallet is configured for TAP in ${resolvedDataDir}. Run 'tap init' to create or select an Open Wallet wallet.`,
		);
	}

	const chain = options.chain ?? yaml?.chain ?? "eip155:84532";
	const executionMode =
		options.executionMode ?? yaml?.execution?.mode ?? getDefaultExecutionModeForChain(chain);
	const paymasterProvider =
		executionMode === "eoa"
			? undefined
			: (options.paymasterProvider ??
				yaml?.execution?.paymaster_provider ??
				getDefaultPaymasterProviderForMode(executionMode));
	const chains = {
		...DEFAULT_CONFIG.chains,
		...(options.extraChains ?? {}),
	};

	if (yaml?.chains) {
		for (const [caip2, override] of Object.entries(yaml.chains)) {
			const existing = chains[caip2];
			if (existing && override.rpc_url) {
				chains[caip2] = { ...existing, rpcUrl: override.rpc_url };
			}
			if (existing && override.registry_address) {
				chains[caip2] = {
					...existing,
					registryAddress: override.registry_address as `0x${string}`,
				};
			}
		}
	}

	return {
		agentId: agentId ?? 0,
		chain,
		account,
		wallet,
		dataDir: resolvedDataDir,
		chains,
		inviteExpirySeconds: yaml?.invite_expiry_seconds ?? DEFAULT_CONFIG.inviteExpirySeconds,
		resolveCacheTtlMs: DEFAULT_CONFIG.resolveCacheTtlMs,
		resolveCacheMaxEntries: DEFAULT_CONFIG.resolveCacheMaxEntries,
		xmtpEnv: yaml?.xmtp?.env ?? DEFAULT_CONFIG.xmtpEnv,
		xmtpDbEncryptionKey,
		ipfs: {
			provider: yaml?.ipfs?.provider ?? DEFAULT_CONFIG.ipfs?.provider,
			tackApiUrl: yaml?.ipfs?.tack_api_url,
		},
		execution: {
			mode: executionMode,
			...(paymasterProvider ? { paymasterProvider } : {}),
		},
	};
}

function loadYamlConfig(configPath: string): StoredYamlConfig | undefined {
	if (!existsSync(configPath)) {
		return undefined;
	}
	return YAML.parse(readFileSync(configPath, "utf-8")) as StoredYamlConfig;
}

function resolveStoredWalletConfig(
	storedWallet: StoredYamlConfig["wallet"] | undefined,
): OpenWalletConfig | undefined {
	if (!storedWallet) {
		return undefined;
	}

	if (storedWallet.provider !== "open-wallet") {
		throw new Error(
			`Unsupported wallet provider in config.yaml: ${storedWallet.provider}. Expected "open-wallet".`,
		);
	}

	if (!storedWallet.name?.trim()) {
		throw new Error("config.yaml wallet.name is required when wallet.provider is open-wallet");
	}

	return {
		provider: "open-wallet",
		name: storedWallet.name.trim(),
		...(storedWallet.id?.trim() ? { id: storedWallet.id.trim() } : {}),
		...(storedWallet.vault_path?.trim() ? { vaultPath: storedWallet.vault_path.trim() } : {}),
	};
}

async function loadLegacyKeyfile(
	dataDir: string,
): Promise<{ path: string; privateKey: `0x${string}` } | null> {
	const keyPath = join(dataDir, "identity", KEYFILE_NAME);
	if (!existsSync(keyPath)) {
		return null;
	}

	const hex = (await readFile(keyPath, "utf-8")).trim();
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`Invalid keyfile at ${keyPath}: expected 64-char hex`);
	}

	return {
		path: keyPath,
		privateKey: `0x${hex}`,
	};
}

async function migrateLegacyKeyfile(params: {
	dataDir: string;
	configPath: string;
	yaml: StoredYamlConfig | undefined;
	privateKey: `0x${string}`;
}): Promise<{
	wallet: OpenWalletConfig;
	xmtpDbEncryptionKey: `0x${string}`;
	yaml: StoredYamlConfig;
}> {
	const ensuredWallet = ensureOpenWallet({
		dataDir: params.dataDir,
		privateKey: params.privateKey,
		vaultPath: resolveStoredWalletConfig(params.yaml?.wallet)?.vaultPath,
	});
	const xmtpDbEncryptionKey =
		(params.yaml?.xmtp?.db_encryption_key as `0x${string}` | undefined) ??
		derivePrivateKeyXmtpDbEncryptionKey(params.privateKey);

	const nextYaml: StoredYamlConfig = {
		...(params.yaml ?? {}),
		wallet: {
			provider: "open-wallet",
			name: ensuredWallet.wallet.name,
			...(ensuredWallet.wallet.id ? { id: ensuredWallet.wallet.id } : {}),
			...(ensuredWallet.wallet.vaultPath ? { vault_path: ensuredWallet.wallet.vaultPath } : {}),
		},
		xmtp: {
			...(params.yaml?.xmtp ?? {}),
			db_encryption_key: xmtpDbEncryptionKey,
		},
	};

	await writeYamlConfigAtomic(params.configPath, YAML.stringify(nextYaml));

	const keyPath = join(params.dataDir, "identity", KEYFILE_NAME);
	await rm(keyPath, { force: true });
	await rm(join(params.dataDir, "identity"), { recursive: false, force: true }).catch(() => {});

	return {
		wallet: ensuredWallet.wallet,
		xmtpDbEncryptionKey,
		yaml: nextYaml,
	};
}

async function writeYamlConfigAtomic(configPath: string, content: string): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempPath, content, "utf-8");
	await rename(tempPath, configPath);
}
