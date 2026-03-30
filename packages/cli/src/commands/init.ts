import { randomBytes } from "node:crypto";
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
import {
	createOwsWallet,
	deriveXmtpDbEncryptionKey,
	ensureOwsInstalled,
	listOwsWallets,
} from "../lib/ows.js";
import { promptInput } from "../lib/prompt.js";
import type { GlobalOptions } from "../types.js";

export interface InitOptions {
	chain?: string;
	/** Pre-select wallet by name (non-interactive). */
	wallet?: string;
	/** OWS wallet passphrase (non-interactive). */
	passphrase?: string;
	/** Skip interactive prompts — use defaults. */
	nonInteractive?: boolean;
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
			? ((YAML.parse(await readFile(configPath, "utf-8")) as {
					chain?: string;
					ows?: { wallet?: string; passphrase?: string };
					xmtp?: { db_encryption_key?: string };
				} | null) ?? undefined)
			: undefined;

		// Reuse the saved chain when config already exists; otherwise fall back to the CLI default.
		const chain = resolveChainAlias(existingConfig?.chain ?? cmdOpts?.chain ?? DEFAULT_CHAIN_ALIAS);
		const chainConfig = ALL_CHAINS[chain];
		const chainLabel = chainConfig?.name ?? chain;
		const executionMode = getDefaultExecutionModeForChain(chain);
		const paymasterProvider = getDefaultPaymasterProviderForMode(executionMode);

		// OWS wallet setup — only when writing a new config
		let owsWallet: string | undefined = existingConfig?.ows?.wallet;
		let owsPassphrase: string | undefined = existingConfig?.ows?.passphrase;
		let xmtpDbEncryptionKey: string | undefined = existingConfig?.xmtp?.db_encryption_key;

		if (!existsSync(configPath)) {
			// Ensure OWS is available
			await ensureOwsInstalled();

			const walletSetup = await setupWallet(opts, cmdOpts);
			owsWallet = walletSetup.walletName;
			owsPassphrase = walletSetup.passphrase;

			// Derive XMTP DB encryption key
			xmtpDbEncryptionKey = deriveXmtpDbEncryptionKey(owsWallet, chain, owsPassphrase);
		}

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

			if (owsWallet) {
				yamlConfig.ows = {
					wallet: owsWallet,
					passphrase: owsPassphrase ?? "",
				};
			}

			if (xmtpDbEncryptionKey) {
				yamlConfig.xmtp = {
					db_encryption_key: xmtpDbEncryptionKey,
				};
			}

			if (Object.keys(chainsYaml).length > 0) {
				yamlConfig.chains = chainsYaml;
			}

			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");
			info(`Created config at ${configPath}`, opts);
		}

		const nextSteps: string[] = [`Chain: ${chainLabel}`];

		if (owsWallet) {
			nextSteps.push(`Wallet: ${owsWallet}`);
		} else {
			nextSteps.push("Configure OWS wallet: tap config set ows.wallet <wallet-name>");
			nextSteps.push("Configure OWS passphrase: tap config set ows.passphrase <passphrase>");
		}

		nextSteps.push(
			`Register: tap register create --name "MyAgent" --description "..." --capabilities "chat"`,
		);

		const result = {
			chain,
			chain_name: chainLabel,
			config: configPath,
			data_dir: dataDir,
			...(owsWallet ? { wallet: owsWallet } : {}),
			next_steps: nextSteps,
		};

		success(result, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

// ─── Wallet Setup ───────────────────────────────────────────────────────

interface WalletSetupResult {
	walletName: string;
	passphrase: string;
}

async function setupWallet(opts: GlobalOptions, cmdOpts?: InitOptions): Promise<WalletSetupResult> {
	// Non-interactive: use provided wallet name or create with defaults
	if (cmdOpts?.nonInteractive || cmdOpts?.wallet) {
		const walletName = cmdOpts?.wallet ?? `tap-${randomBytes(4).toString("hex")}`;
		const passphrase = cmdOpts?.passphrase ?? "";

		// Check if wallet already exists
		const existingWallets = listOwsWallets();
		const existing = existingWallets.find((w) => w.name === walletName);
		if (existing) {
			info(`Using existing wallet: ${walletName} (${existing.address})`, opts);
			return { walletName, passphrase };
		}

		const created = createOwsWallet(walletName, passphrase || undefined);
		info(`Created wallet: ${created.name} (${created.address})`, opts);
		return { walletName: created.name, passphrase };
	}

	// Interactive flow
	const existingWallets = listOwsWallets();

	if (existingWallets.length > 0) {
		info("\nExisting OWS wallets:", opts);
		for (let i = 0; i < existingWallets.length; i++) {
			const w = existingWallets[i]!;
			info(`  ${i + 1}. ${w.name} (${w.address})`, opts);
		}

		const choice = await promptInput(
			"\nCreate a new wallet or use an existing one? [new/1/2/...]: ",
		);

		if (choice && choice !== "new") {
			const idx = Number.parseInt(choice, 10) - 1;
			if (idx >= 0 && idx < existingWallets.length) {
				const selected = existingWallets[idx]!;
				info(`Using wallet: ${selected.name}`, opts);
				const passphrase = (await promptInput("Wallet passphrase (leave blank if none): ")) ?? "";
				return { walletName: selected.name, passphrase };
			}
		}
	}

	// Create new wallet
	const defaultName = `tap-${randomBytes(4).toString("hex")}`;
	const nameInput = await promptInput(`Wallet name [${defaultName}]: `);
	const walletName = nameInput && nameInput.length > 0 ? nameInput : defaultName;

	const passphrase = (await promptInput("Set a wallet passphrase (leave blank for none): ")) ?? "";

	const created = createOwsWallet(walletName, passphrase || undefined);
	info(`Created wallet: ${created.name} (${created.address})`, opts);

	return { walletName: created.name, passphrase };
}
