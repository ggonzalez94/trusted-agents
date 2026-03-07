import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTrustedAgentConfigFromDataDir } from "trusted-agents-core";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { ALL_CHAINS, DEFAULT_CHAIN_ALIAS, resolveChainAlias } from "./chains.js";

const LEGACY_CONFIG_PATH = join(homedir(), ".config", "trustedagents", "config.yaml");
const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "trustedagents");
const FALLBACK_DATA_DIR = join(homedir(), ".trustedagents");

export function resolveDataDir(opts: GlobalOptions): string {
	// Priority: CLI flag > env > default
	if (opts.dataDir) return opts.dataDir;
	const envDir = process.env.TAP_DATA_DIR;
	if (envDir) return envDir;
	// Use XDG path if it exists, otherwise fallback
	if (existsSync(DEFAULT_DATA_DIR)) return DEFAULT_DATA_DIR;
	return FALLBACK_DATA_DIR;
}

function hasExplicitDataDir(opts: GlobalOptions): boolean {
	return Boolean(opts.dataDir || process.env.TAP_DATA_DIR);
}

export function resolveConfigPath(opts: GlobalOptions, dataDir: string): string {
	if (opts.config) return opts.config;
	// New default: config lives inside data dir
	const newPath = join(dataDir, "config.yaml");
	if (existsSync(newPath)) return newPath;
	// Explicit data-dir selection must stay isolated from legacy config.
	if (hasExplicitDataDir(opts)) return newPath;
	// Legacy fallback: ~/.config/trustedagents/config.yaml
	if (existsSync(LEGACY_CONFIG_PATH)) return LEGACY_CONFIG_PATH;
	// Default to new path (init will create it here)
	return newPath;
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
	const agentIdStr = process.env.TAP_AGENT_ID;
	const agentId = agentIdStr !== undefined ? Number.parseInt(agentIdStr, 10) : undefined;
	const chainRaw =
		opts.chain ??
		process.env.TAP_CHAIN ??
		(!existsSync(configPath) ? DEFAULT_CHAIN_ALIAS : undefined);
	const chain = chainRaw ? resolveChainAlias(chainRaw) : undefined;
	const envKey = process.env.TAP_PRIVATE_KEY;
	const privateKey = envKey
		? ((envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`)
		: undefined;

	return await loadTrustedAgentConfigFromDataDir(dataDir, {
		requireAgentId,
		agentId,
		chain,
		privateKey,
		configPath,
		extraChains: ALL_CHAINS,
	});
}
