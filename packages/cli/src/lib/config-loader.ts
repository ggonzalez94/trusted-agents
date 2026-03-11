import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ExecutionMode,
	type ExecutionPaymasterProvider,
	type TrustedAgentsConfig,
	getDefaultExecutionModeForChain,
	getDefaultPaymasterProviderForMode,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { ALL_CHAINS, DEFAULT_CHAIN_ALIAS, resolveChainAlias } from "./chains.js";

export { getDefaultExecutionModeForChain, getDefaultPaymasterProviderForMode };

export function resolveDataDir(opts: GlobalOptions): string {
	if (opts.dataDir) {
		return opts.dataDir;
	}
	const envDir = process.env.TAP_DATA_DIR;
	if (envDir) {
		return envDir;
	}
	return join(process.env.HOME ?? homedir(), ".trustedagents");
}

export function resolveConfigPath(opts: GlobalOptions, dataDir: string): string {
	if (opts.config) {
		return opts.config;
	}
	return join(dataDir, "config.yaml");
}

interface LoadConfigOptions {
	requireAgentId?: boolean;
}

export async function loadConfig(
	opts: GlobalOptions,
	{ requireAgentId = true }: LoadConfigOptions = {},
): Promise<TrustedAgentsConfig> {
	const dataDir = resolveDataDir(opts);
	const configPath = resolveConfigPath(opts, dataDir);
	validateConfigPathInDataDir(opts, configPath, dataDir);
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
	const executionMode = process.env.TAP_EXECUTION_MODE as ExecutionMode | undefined;
	const paymasterProvider = process.env.TAP_PAYMASTER_PROVIDER as
		| ExecutionPaymasterProvider
		| undefined;
	const rpcUrl = opts.rpcUrl ?? process.env.TAP_RPC_URL;

	const config = await loadTrustedAgentConfigFromDataDir(dataDir, {
		requireAgentId,
		agentId,
		chain,
		privateKey,
		configPath,
		extraChains: ALL_CHAINS,
		executionMode,
		paymasterProvider,
	});

	const normalizedChain = resolveChainAlias(config.chain);
	const normalizedConfig =
		normalizedChain === config.chain ? config : { ...config, chain: normalizedChain };
	if (!rpcUrl) {
		return normalizedConfig;
	}

	const selectedChain = normalizedConfig.chains[normalizedConfig.chain];
	if (!selectedChain) {
		return normalizedConfig;
	}

	return {
		...normalizedConfig,
		chains: {
			...normalizedConfig.chains,
			[normalizedConfig.chain]: {
				...selectedChain,
				rpcUrl,
			},
		},
	};
}

export function validateConfigPathInDataDir(
	opts: Pick<GlobalOptions, "config" | "dataDir">,
	configPath: string,
	dataDir: string,
): void {
	const hasExplicitDataDir = opts.dataDir !== undefined || process.env.TAP_DATA_DIR !== undefined;
	if (opts.config === undefined || !hasExplicitDataDir) {
		return;
	}

	const expectedPath = resolve(dataDir, "config.yaml");
	if (resolve(configPath) !== expectedPath) {
		throw new Error(
			`Config path must match the TAP data dir config at ${expectedPath}. Use --data-dir to select the agent instead of mixing --config with another data dir.`,
		);
	}
}
