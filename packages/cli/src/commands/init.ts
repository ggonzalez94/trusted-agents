import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface InitOptions {
	chain?: string;
}

export async function initCommand(opts: GlobalOptions, cmdOpts?: InitOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);

		// Check if config already exists
		if (existsSync(configPath)) {
			info(`Config already exists at ${configPath}. Use 'tap config set' to modify.`, opts);
		}

		// Create data directory structure
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await mkdir(join(dataDir, "xmtp"), { recursive: true });

		const existingConfig = existsSync(configPath)
			? ((YAML.parse(await readFile(configPath, "utf-8")) as { chain?: string } | null) ??
				undefined)
			: undefined;

		// Reuse the saved chain when config already exists; otherwise fall back to the CLI default.
		const chain = resolveChainAlias(existingConfig?.chain ?? cmdOpts?.chain ?? DEFAULT_CHAIN_ALIAS);
		const chainConfig = ALL_CHAINS[chain];
		const chainLabel = chainConfig?.name ?? chain;
		const executionMode = getDefaultExecutionModeForChain(chain);
		const paymasterProvider = getDefaultPaymasterProviderForMode(executionMode);

		// Write config file if it doesn't exist
		if (!existsSync(configPath)) {
			// Merge default chains with any extra chains the CLI knows about
			const chainsYaml: Record<string, Record<string, string>> = {};
			if (chainConfig && chain !== "eip155:8453") {
				chainsYaml[chain] = {
					rpc_url: chainConfig.rpcUrl,
					registry_address: chainConfig.registryAddress,
				};
			}

			const yamlConfig: Record<string, unknown> = {
				agent_id: -1,
				chain,
				execution: {
					mode: executionMode,
					...(paymasterProvider ? { paymaster_provider: paymasterProvider } : {}),
				},
			};
			if (Object.keys(chainsYaml).length > 0) {
				yamlConfig.chains = chainsYaml;
			}

			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");
			info(`Created config at ${configPath}`, opts);
		}

		const nextSteps = [
			`Chain: ${chainLabel}`,
			"Configure OWS wallet: tap config set ows.wallet <wallet-name>",
			"Configure OWS API key: tap config set ows.api_key <api-key>",
			`Register: tap register --name "MyAgent" --description "..." --capabilities "chat"`,
		];

		const result = {
			chain,
			chain_name: chainLabel,
			config: configPath,
			data_dir: dataDir,
			next_steps: nextSteps,
		};

		success(result, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
