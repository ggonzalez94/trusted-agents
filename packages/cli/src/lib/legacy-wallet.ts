import { join } from "node:path";

export const LEGACY_WALLET_IDENTITY_DIR = "identity";
export const LEGACY_WALLET_KEY_FILE = "agent.key";

export function legacyWalletIdentityDir(dataDir: string): string {
	return join(dataDir, LEGACY_WALLET_IDENTITY_DIR);
}

export function legacyWalletKeyPath(dataDir: string): string {
	return join(legacyWalletIdentityDir(dataDir), LEGACY_WALLET_KEY_FILE);
}
