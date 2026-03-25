import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import YAML from "yaml";
import { ALL_CHAINS, DEFAULT_CHAIN_ALIAS, resolveChainAlias } from "../lib/chains.js";
import {
	getDefaultExecutionModeForChain,
	getDefaultPaymasterProviderForMode,
	resolveConfigPath,
	resolveDataDir,
} from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { generateKeyfile, importKeyfile, loadKeyfile } from "../lib/keyfile.js";
import { error, info, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export interface InitOptions {
	privateKey?: string;
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
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await mkdir(join(dataDir, "xmtp"), { recursive: true });

		// Handle private key: import, load existing, or generate new
		const keyfileDest = join(dataDir, "identity", "agent.key");
		let address: string;

		if (cmdOpts?.privateKey) {
			// Import user-provided private key
			if (existsSync(keyfileDest)) {
				info(`Overwriting existing keyfile at ${keyfileDest}`, opts);
			}
			const result = await importKeyfile(dataDir, cmdOpts.privateKey);
			address = result.address;
			info(`Imported private key to ${result.path}`, opts);
		} else if (existsSync(keyfileDest)) {
			info(`Keyfile already exists at ${keyfileDest}`, opts);
			const key = await loadKeyfile(dataDir);
			const account = privateKeyToAccount(key);
			address = account.address;
		} else {
			const result = await generateKeyfile(dataDir);
			address = result.address;
			info(`Generated keyfile at ${result.path}`, opts);
		}

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

		const fundingSteps =
			executionMode === "eip7702"
				? [
						`Agent address: ${address}`,
						"Base defaults to EIP-7702 with Circle Paymaster.",
						"Fund this same address with Base mainnet USDC.",
						"That single Base mainnet USDC balance covers registration gas and x402 IPFS uploads.",
					]
				: executionMode === "eip4337"
					? [
							`Agent owner address: ${address}`,
							`${chainLabel} defaults to EIP-4337 with Servo Paymaster.`,
							"Fund the Servo execution account with USDC (run `tap balance --json` to see `execution_address`).",
							"`tap register` deploys the Servo execution account before the Tack upload on Taiko.",
							"IPFS uploads auto-select based on chain (Tack on Taiko, Pinata x402 on Base). Override with --ipfs-provider or --pinata-jwt.",
						]
					: [
							`Agent address: ${address}`,
							`${chainLabel} currently uses direct EOA transactions in this CLI.`,
							`Fund this address with native gas on ${chainLabel}.`,
							"IPFS uploads auto-select based on chain (Tack on Taiko, Pinata x402 on Base). Override with --ipfs-provider or --pinata-jwt.",
						];

		const result = {
			address,
			chain,
			chain_name: chainLabel,
			keyfile: keyfileDest,
			config: configPath,
			data_dir: dataDir,
			next_steps: [
				...fundingSteps,
				`Register: tap register --name "MyAgent" --description "..." --capabilities "chat"`,
			],
		};

		success(result, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
