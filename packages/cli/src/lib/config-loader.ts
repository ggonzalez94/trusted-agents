import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "trusted-agents-core";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import YAML from "yaml";
import type { GlobalOptions } from "../types.js";
import { ALL_CHAINS, resolveChainAlias } from "./chains.js";
import { loadKeyfile } from "./keyfile.js";

const LEGACY_CONFIG_PATH = join(homedir(), ".config", "trustedagents", "config.yaml");
const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "trustedagents");
const FALLBACK_DATA_DIR = join(homedir(), ".trustedagents");

interface YamlConfig {
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

export function resolveDataDir(opts: GlobalOptions): string {
	// Priority: CLI flag > env > default
	if (opts.dataDir) return opts.dataDir;
	const envDir = process.env.TAP_DATA_DIR;
	if (envDir) return envDir;
	// Use XDG path if it exists, otherwise fallback
	if (existsSync(DEFAULT_DATA_DIR)) return DEFAULT_DATA_DIR;
	return FALLBACK_DATA_DIR;
}

export function resolveConfigPath(opts: GlobalOptions, dataDir: string): string {
	if (opts.config) return opts.config;
	// New default: config lives inside data dir
	const newPath = join(dataDir, "config.yaml");
	if (existsSync(newPath)) return newPath;
	// Legacy fallback: ~/.config/trustedagents/config.yaml
	if (existsSync(LEGACY_CONFIG_PATH)) return LEGACY_CONFIG_PATH;
	// Default to new path (init will create it here)
	return newPath;
}

function loadYamlConfig(configPath: string): YamlConfig | undefined {
	if (!existsSync(configPath)) return undefined;
	const content = readFileSync(configPath, "utf-8");
	return YAML.parse(content) as YamlConfig;
}

interface LoadConfigOptions {
	/** Skip the agent_id >= 0 validation (used by `tap register` before ID exists). */
	requireAgentId?: boolean;
}

export async function loadConfig(
	opts: GlobalOptions,
	{ requireAgentId = true }: LoadConfigOptions = {},
): Promise<TrustedAgentsConfig> {
	const dataDir = resolveDataDir(opts);
	const configPath = resolveConfigPath(opts, dataDir);
	const yaml = loadYamlConfig(configPath);

	// Resolve agent ID: CLI flag > env > yaml > error
	const agentIdStr = process.env.TAP_AGENT_ID;
	const agentId = agentIdStr !== undefined ? Number.parseInt(agentIdStr, 10) : yaml?.agent_id;

	if (requireAgentId) {
		if (agentId === undefined || Number.isNaN(agentId) || agentId < 0) {
			throw new Error(
				"agent_id is required and must be >= 0. Set TAP_AGENT_ID env var or agent_id in config.yaml (run `tap init` first, then `tap register` to register on-chain)",
			);
		}
	}

	// Resolve chain: CLI flag > env > yaml > default (Base Sepolia)
	const chainRaw = opts.chain ?? process.env.TAP_CHAIN ?? yaml?.chain ?? "base-sepolia";
	const chain = resolveChainAlias(chainRaw);

	// Resolve private key: env > keyfile
	let privateKey: `0x${string}`;
	const envKey = process.env.TAP_PRIVATE_KEY;
	if (envKey) {
		privateKey = envKey.startsWith("0x") ? (envKey as `0x${string}`) : `0x${envKey}`;
	} else {
		privateKey = await loadKeyfile(dataDir);
	}

	// Merge chain configs (CLI knows about more chains than core defaults)
	const chains = { ...ALL_CHAINS };
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
		dataDir,
		chains,
		inviteExpirySeconds: yaml?.invite_expiry_seconds ?? DEFAULT_CONFIG.inviteExpirySeconds,
		resolveCacheTtlMs: DEFAULT_CONFIG.resolveCacheTtlMs,
		resolveCacheMaxEntries: DEFAULT_CONFIG.resolveCacheMaxEntries,
		xmtpEnv: yaml?.xmtp?.env ?? DEFAULT_CONFIG.xmtpEnv,
		xmtpDbEncryptionKey: yaml?.xmtp?.db_encryption_key as `0x${string}` | undefined,
	};
}
