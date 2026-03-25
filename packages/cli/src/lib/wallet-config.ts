import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, OwsSigningProvider, type TrustedAgentsConfig } from "trusted-agents-core";
import YAML from "yaml";

interface StoredWalletConfig {
	ows?: {
		wallet?: string;
		api_key?: string;
	};
}

interface WalletConfigStatusOptions {
	dataDir: string;
	configPath?: string;
	owsWallet?: string;
	owsApiKey?: string;
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
	apiKey: string;
} {
	const configPath = options.configPath ?? join(options.dataDir, "config.yaml");
	const stored = loadStoredWalletConfig(configPath);

	return {
		wallet: options.owsWallet ?? stored?.ows?.wallet ?? "",
		apiKey: options.owsApiKey ?? stored?.ows?.api_key ?? "",
	};
}

export function getLegacyWalletMigrationWarning(
	options: WalletConfigStatusOptions,
): string | undefined {
	const effective = resolveEffectiveOwsConfig(options);
	if (effective.wallet && effective.apiKey) {
		return undefined;
	}

	const keyPath = join(options.dataDir, "identity", "agent.key");
	if (!existsSync(keyPath)) {
		return undefined;
	}

	return `Legacy TAP wallet detected at ${keyPath}. This agent still uses a raw key and has no OWS wallet config. Run \`tap migrate-wallet\` to upgrade it.`;
}

function assertWalletConfigured(config: WalletBackedConfig): void {
	if (config.ows.wallet && config.ows.apiKey) {
		return;
	}

	const legacyWarning = getLegacyWalletMigrationWarning({
		dataDir: config.dataDir,
		owsWallet: config.ows.wallet,
		owsApiKey: config.ows.apiKey,
	});
	if (legacyWarning) {
		throw new ConfigError(legacyWarning);
	}

	throw new ConfigError(
		"OWS wallet config is missing for this agent. Run `tap init` to create an OWS wallet and API key.",
	);
}

export function createConfiguredSigningProvider(
	config: WalletBackedConfig,
	chain = config.chain,
): OwsSigningProvider {
	assertWalletConfigured(config);
	return new OwsSigningProvider(config.ows.wallet, chain, config.ows.apiKey);
}
