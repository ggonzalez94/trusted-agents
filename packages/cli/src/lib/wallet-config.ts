import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, OwsSigningProvider, type TrustedAgentsConfig } from "trusted-agents-core";
import YAML from "yaml";

interface StoredWalletConfig {
	ows?: {
		wallet?: string;
		passphrase?: string;
	};
}

interface WalletConfigStatusOptions {
	dataDir: string;
	configPath?: string;
	owsWallet?: string;
	owsPassphrase?: string;
}

type WalletBackedConfig = Pick<TrustedAgentsConfig, "dataDir" | "chain" | "ows">;

function loadStoredWalletConfig(configPath: string): StoredWalletConfig | undefined {
	if (!existsSync(configPath)) {
		return undefined;
	}

	try {
		return (
			(YAML.parse(readFileSync(configPath, "utf-8")) as StoredWalletConfig | null) ?? undefined
		);
	} catch {
		return undefined;
	}
}

function resolveEffectiveOwsConfig(options: WalletConfigStatusOptions): {
	wallet: string;
	passphrase: string;
} {
	const configPath = options.configPath ?? join(options.dataDir, "config.yaml");
	const stored = loadStoredWalletConfig(configPath);

	return {
		wallet: options.owsWallet ?? stored?.ows?.wallet ?? "",
		passphrase: options.owsPassphrase ?? stored?.ows?.passphrase ?? "",
	};
}

export function getLegacyWalletMigrationWarning(
	options: WalletConfigStatusOptions,
): string | undefined {
	const effective = resolveEffectiveOwsConfig(options);
	if (effective.wallet) {
		return undefined;
	}

	const keyPath = join(options.dataDir, "identity", "agent.key");
	if (!existsSync(keyPath)) {
		return undefined;
	}

	return `Legacy TAP wallet detected at ${keyPath}. This agent still uses a raw key and has no OWS wallet config. Run \`tap migrate-wallet\` to upgrade it.`;
}

function assertWalletConfigured(config: WalletBackedConfig): void {
	if (config.ows.wallet) {
		return;
	}

	const legacyWarning = getLegacyWalletMigrationWarning({
		dataDir: config.dataDir,
		owsWallet: config.ows.wallet,
		owsPassphrase: config.ows.passphrase,
	});
	if (legacyWarning) {
		throw new ConfigError(legacyWarning);
	}

	throw new ConfigError(
		"OWS wallet config is missing for this agent. Run `tap init` to create an OWS wallet and set its passphrase.",
	);
}

export function createConfiguredSigningProvider(
	config: WalletBackedConfig,
	chain = config.chain,
): OwsSigningProvider {
	assertWalletConfigured(config);
	return new OwsSigningProvider(config.ows.wallet, chain, config.ows.passphrase);
}
