import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { resolveDataDir } from "../common/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { ChainConfig, TrustedAgentsConfig } from "./types.js";

const KEYFILE_NAME = "agent.key";

interface StoredYamlConfig {
	agent_id?: number;
	chain?: string;
	xmtp?: {
		env?: "dev" | "production" | "local";
		db_encryption_key?: string;
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
}

export function resolveTrustedAgentConfigPath(dataDir: string): string {
	return join(resolveDataDir(dataDir), "config.yaml");
}

export async function loadTrustedAgentConfigFromDataDir(
	dataDir: string,
	options: LoadTrustedAgentConfigOptions = {},
): Promise<TrustedAgentsConfig> {
	const resolvedDataDir = resolveDataDir(dataDir);
	const configPath = options.configPath ?? resolveTrustedAgentConfigPath(resolvedDataDir);
	const yaml = loadYamlConfig(configPath);

	const agentId = options.agentId ?? yaml?.agent_id;
	if (options.requireAgentId ?? true) {
		if (agentId === undefined || Number.isNaN(agentId) || agentId < 0) {
			throw new Error(
				"agent_id is required and must be >= 0. Set it in config.yaml or through the host runtime before using TAP",
			);
		}
	}

	const privateKey = options.privateKey ?? (await loadKeyfile(resolvedDataDir));
	const chain = options.chain ?? yaml?.chain ?? "eip155:84532";
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
		privateKey,
		dataDir: resolvedDataDir,
		chains,
		inviteExpirySeconds: yaml?.invite_expiry_seconds ?? DEFAULT_CONFIG.inviteExpirySeconds,
		resolveCacheTtlMs: DEFAULT_CONFIG.resolveCacheTtlMs,
		resolveCacheMaxEntries: DEFAULT_CONFIG.resolveCacheMaxEntries,
		xmtpEnv: yaml?.xmtp?.env ?? DEFAULT_CONFIG.xmtpEnv,
		xmtpDbEncryptionKey: yaml?.xmtp?.db_encryption_key as `0x${string}` | undefined,
	};
}

function loadYamlConfig(configPath: string): StoredYamlConfig | undefined {
	if (!existsSync(configPath)) {
		return undefined;
	}
	return YAML.parse(readFileSync(configPath, "utf-8")) as StoredYamlConfig;
}

async function loadKeyfile(dataDir: string): Promise<`0x${string}`> {
	const keyPath = join(dataDir, "identity", KEYFILE_NAME);
	const hex = (await readFile(keyPath, "utf-8")).trim();

	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`Invalid keyfile at ${keyPath}: expected 64-char hex`);
	}

	return `0x${hex}`;
}
