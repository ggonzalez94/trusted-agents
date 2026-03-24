import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename } from "node:path";
import type {
	AccountInfo as OwsAccountInfo,
	WalletInfo as OwsWalletInfo,
} from "@open-wallet-standard/core";
import { getAddress, keccak256, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { OpenWalletConfig, TrustedAgentsAccount } from "../config/types.js";

const OWS_VAULT_PATH_ENV = "TAP_OWS_VAULT_PATH";
const OWS_PASSPHRASE_ENV = "TAP_OWS_PASSPHRASE";
const OWS_EVM_CHAIN_ID = "eip155:1";

const require = createRequire(import.meta.url);
const ows = require("@open-wallet-standard/core") as typeof import("@open-wallet-standard/core");

export interface EnsureOpenWalletOptions {
	dataDir: string;
	privateKey?: `0x${string}`;
	walletName?: string;
	vaultPath?: string;
	existingWallet?: OpenWalletConfig;
}

export interface EnsureOpenWalletResult {
	wallet: OpenWalletConfig;
	address: `0x${string}`;
	status:
		| "existing-config"
		| "reused-single-existing"
		| "reused-by-name"
		| "reused-by-address"
		| "created"
		| "imported";
}

function resolveOwsVaultPath(vaultPath?: string): string | undefined {
	const envPath = process.env[OWS_VAULT_PATH_ENV]?.trim();
	return envPath || vaultPath;
}

function resolveOwsPassphrase(): string | undefined {
	const envPassphrase = process.env[OWS_PASSPHRASE_ENV]?.trim();
	return envPassphrase || undefined;
}

function getWalletLookupId(wallet: OpenWalletConfig): string {
	return wallet.id ?? wallet.name;
}

function normalizeWalletNameSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return normalized || "agent";
}

function defaultWalletNameForDataDir(dataDir: string): string {
	const base = basename(dataDir);
	const normalized = normalizeWalletNameSegment(base === ".trustedagents" ? "tap-agent" : base);
	return normalized.startsWith("tap-") ? normalized : `tap-${normalized}`;
}

function uniqueWalletName(
	baseName: string,
	existingWallets: OwsWalletInfo[],
	dataDir: string,
): string {
	const existingNames = new Set(existingWallets.map((wallet) => wallet.name));
	if (!existingNames.has(baseName)) {
		return baseName;
	}

	const suffix = createHash("sha256").update(dataDir).digest("hex").slice(0, 8);
	const candidate = `${baseName}-${suffix}`;
	if (!existingNames.has(candidate)) {
		return candidate;
	}

	let counter = 2;
	while (existingNames.has(`${candidate}-${counter}`)) {
		counter += 1;
	}
	return `${candidate}-${counter}`;
}

function normalizePrivateKey(privateKey: `0x${string}` | string): `0x${string}` {
	return (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

function normalizeWalletConfig(wallet: OwsWalletInfo, vaultPath?: string): OpenWalletConfig {
	return {
		provider: "open-wallet",
		id: wallet.id,
		name: wallet.name,
		...(vaultPath ? { vaultPath } : {}),
	};
}

function getWallets(vaultPath?: string): OwsWalletInfo[] {
	return ows.listWallets(resolveOwsVaultPath(vaultPath) ?? null) as OwsWalletInfo[];
}

function getWalletByReference(wallet: OpenWalletConfig): OwsWalletInfo {
	try {
		return ows.getWallet(
			getWalletLookupId(wallet),
			resolveOwsVaultPath(wallet.vaultPath) ?? null,
		) as OwsWalletInfo;
	} catch (error) {
		throw new Error(
			`Open Wallet wallet "${wallet.name}" could not be loaded. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function getEvmAccountInfo(wallet: OwsWalletInfo): OwsAccountInfo {
	const evmAccount = wallet.accounts.find((account) => account.chainId === OWS_EVM_CHAIN_ID);
	if (!evmAccount) {
		throw new Error(`Open Wallet wallet "${wallet.name}" is missing an EVM account`);
	}
	return evmAccount;
}

export function getOpenWalletAddress(wallet: OpenWalletConfig): `0x${string}` {
	const info = getWalletByReference(wallet);
	return getAddress(getEvmAccountInfo(info).address);
}

function findWalletByAddress(
	wallets: OwsWalletInfo[],
	address: `0x${string}`,
): OwsWalletInfo | undefined {
	return wallets.find((wallet) => {
		try {
			return getEvmAccountInfo(wallet).address.toLowerCase() === address.toLowerCase();
		} catch {
			return false;
		}
	});
}

export function ensureOpenWallet(options: EnsureOpenWalletOptions): EnsureOpenWalletResult {
	const vaultPath = resolveOwsVaultPath(options.vaultPath);

	if (options.existingWallet) {
		return {
			wallet: {
				...options.existingWallet,
				...(vaultPath ? { vaultPath } : {}),
			},
			address: getOpenWalletAddress({
				...options.existingWallet,
				...(vaultPath ? { vaultPath } : {}),
			}),
			status: "existing-config",
		};
	}

	const wallets = getWallets(vaultPath);
	const requestedName = options.walletName?.trim();
	const desiredName = requestedName || defaultWalletNameForDataDir(options.dataDir);

	if (options.privateKey) {
		const normalizedPrivateKey = normalizePrivateKey(options.privateKey);
		const account = privateKeyToAccount(normalizedPrivateKey);
		const existingByAddress = findWalletByAddress(wallets, account.address);
		if (existingByAddress) {
			return {
				wallet: normalizeWalletConfig(existingByAddress, vaultPath),
				address: account.address,
				status: "reused-by-address",
			};
		}

		const importName = uniqueWalletName(desiredName, wallets, options.dataDir);
		const createdWallet = ows.importWalletPrivateKey(
			importName,
			normalizedPrivateKey.slice(2),
			resolveOwsPassphrase() ?? null,
			vaultPath ?? null,
			"evm",
		) as OwsWalletInfo;

		return {
			wallet: normalizeWalletConfig(createdWallet, vaultPath),
			address: getAddress(getEvmAccountInfo(createdWallet).address),
			status: "imported",
		};
	}

	if (!requestedName && wallets.length === 1) {
		const onlyWallet = wallets[0]!;
		return {
			wallet: normalizeWalletConfig(onlyWallet, vaultPath),
			address: getAddress(getEvmAccountInfo(onlyWallet).address),
			status: "reused-single-existing",
		};
	}

	const existingByName = wallets.find((wallet) => wallet.name === desiredName);
	if (existingByName) {
		return {
			wallet: normalizeWalletConfig(existingByName, vaultPath),
			address: getAddress(getEvmAccountInfo(existingByName).address),
			status: "reused-by-name",
		};
	}

	const createName = uniqueWalletName(desiredName, wallets, options.dataDir);
	const createdWallet = ows.createWallet(
		createName,
		resolveOwsPassphrase() ?? null,
		null,
		vaultPath ?? null,
	) as OwsWalletInfo;

	return {
		wallet: normalizeWalletConfig(createdWallet, vaultPath),
		address: getAddress(getEvmAccountInfo(createdWallet).address),
		status: "created",
	};
}

function parseOpenWalletSecret(secret: string): TrustedAgentsAccount {
	const trimmed = secret.trim();
	if (trimmed.startsWith("{")) {
		let parsed: { secp256k1?: string } | null = null;
		try {
			parsed = JSON.parse(trimmed) as { secp256k1?: string };
		} catch (error) {
			throw new Error(
				`Open Wallet exported malformed secret JSON. ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		const secp256k1 = parsed?.secp256k1?.trim();
		if (!secp256k1 || !/^[0-9a-fA-F]{64}$/.test(secp256k1)) {
			throw new Error("Open Wallet export is missing a valid secp256k1 key");
		}
		return privateKeyToAccount(`0x${secp256k1}`);
	}

	const mnemonicAccount = mnemonicToAccount(trimmed);
	const privateKeyBytes = mnemonicAccount.getHdKey().privateKey;
	if (!privateKeyBytes) {
		throw new Error("Open Wallet mnemonic export did not include a derivable EVM private key");
	}
	return privateKeyToAccount(toHex(privateKeyBytes));
}

export function resolveAccountFromOpenWallet(wallet: OpenWalletConfig): TrustedAgentsAccount {
	try {
		const secret = ows.exportWallet(
			getWalletLookupId(wallet),
			resolveOwsPassphrase() ?? null,
			resolveOwsVaultPath(wallet.vaultPath) ?? null,
		) as string;
		const account = parseOpenWalletSecret(secret);
		const expectedAddress = getOpenWalletAddress(wallet);
		if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
			throw new Error(
				`Open Wallet account mismatch: expected ${expectedAddress}, resolved ${account.address}`,
			);
		}
		return account;
	} catch (error) {
		throw new Error(
			`Failed to unlock Open Wallet wallet "${wallet.name}". ${
				error instanceof Error ? error.message : String(error)
			} If the wallet is passphrase-protected, set ${OWS_PASSPHRASE_ENV}.`,
		);
	}
}

export function deriveOpenWalletXmtpDbEncryptionKey(wallet: OpenWalletConfig): `0x${string}` {
	return keccak256(toHex(`xmtp-db-encryption:ows:${wallet.id ?? wallet.name}`));
}

export function derivePrivateKeyXmtpDbEncryptionKey(privateKey: `0x${string}`): `0x${string}` {
	return keccak256(toHex(`xmtp-db-encryption:${privateKey}`));
}
