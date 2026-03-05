import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import YAML from "yaml";
import { ALL_CHAINS, resolveChainAlias } from "../lib/chains.js";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
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

		// Resolve chain — default to Base Sepolia for testnet
		const chain = resolveChainAlias(cmdOpts?.chain ?? "base-sepolia");
		const chainConfig = ALL_CHAINS[chain];
		const chainLabel = chainConfig?.name ?? chain;
		const isTestnet = chain !== "eip155:8453" && chain !== "eip155:167000";
		const xmtpEnv = isTestnet ? "dev" : "production";

		// Write config file if it doesn't exist
		if (!existsSync(configPath)) {
			// Merge default chains with any extra chains the CLI knows about
			const chainsYaml: Record<string, Record<string, string>> = {};
			if (chainConfig && !["eip155:8453", "eip155:84532"].includes(chain)) {
				chainsYaml[chain] = {
					rpc_url: chainConfig.rpcUrl,
					registry_address: chainConfig.registryAddress,
				};
			}

			const yamlConfig: Record<string, unknown> = {
				agent_id: -1,
				chain,
				xmtp: { env: xmtpEnv },
			};
			if (Object.keys(chainsYaml).length > 0) {
				yamlConfig.chains = chainsYaml;
			}

			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");
			info(`Created config at ${configPath}`, opts);
		}

		const fundingSteps = [
			`Fund ${address} on ${chainLabel}:`,
			"  ETH → for registration gas",
			"  USDC on Base mainnet → for IPFS upload via x402 (~0.001 USDC)",
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
