import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { keccak256, toHex } from "viem";
import { readYamlFile, writeYamlFileAtomic } from "../lib/atomic-write.js";
import { resolveChainAlias } from "../lib/chains.js";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { legacyWalletKeyPath } from "../lib/legacy-wallet.js";
import { info, success } from "../lib/output.js";
import {
	createOwsApiKey,
	ensureOwsInstalled,
	getOwsWalletAddress,
	importOwsWalletPrivateKey,
	setupOwsPolicy,
} from "../lib/ows.js";
import type { GlobalOptions } from "../types.js";

export interface MigrateWalletOptions {
	passphrase?: string;
	nonInteractive?: boolean;
}

export async function migrateWalletCommand(
	opts: GlobalOptions,
	cmdOpts?: MigrateWalletOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);

		// ── Pre-flight checks ──────────────────────────────────────────

		// Config must exist
		if (!existsSync(configPath)) {
			throw new Error(`No config found at ${configPath}. Run 'tap init' first to set up an agent.`);
		}

		const yaml = (await readYamlFile<Record<string, unknown> | null>(configPath)) ?? {};

		// Already migrated?
		const existingOws = yaml.ows as { wallet?: string; api_key?: string } | undefined;
		if (existingOws?.wallet && existingOws?.api_key) {
			throw new Error("This agent already has OWS wallet configuration. Migration is not needed.");
		}

		// agent.key must exist
		const keyPath = legacyWalletKeyPath(dataDir);
		if (!existsSync(keyPath)) {
			throw new Error(
				`No key file found at ${keyPath}. Either this agent was already migrated or was never initialized with a raw key.`,
			);
		}

		// ── Read existing state ────────────────────────────────────────

		const rawKey = (await readFile(keyPath, "utf-8")).trim();
		// Strip 0x prefix if present, validate hex
		const hexKey = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;
		if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
			throw new Error(`Invalid private key in ${keyPath}. Expected 64 hex characters.`);
		}

		const agentId = yaml.agent_id as number | undefined;
		const chain = resolveChainAlias((yaml.chain as string) ?? "eip155:8453");

		// Compute original address from the raw key for verification
		const { privateKeyToAccount } = await import("viem/accounts");
		const originalAddress = privateKeyToAccount(`0x${hexKey}`).address;

		info(`Migrating agent ${agentId ?? "(unregistered)"} to OWS...`, opts);
		info(`Chain: ${chain}`, opts);
		info(`Address: ${originalAddress}`, opts);

		// ── Step 1: Ensure OWS is installed ────────────────────────────

		await ensureOwsInstalled();

		// ── Step 2: Compute XMTP DB encryption key from OLD key ───────
		// Uses the legacy formula to preserve existing XMTP database
		const xmtpDbEncryptionKey = keccak256(toHex(`xmtp-db-encryption:0x${hexKey}`));

		// ── Step 3: Import key into OWS ───────────────────────────────

		const walletName =
			agentId !== undefined && agentId >= 0
				? `tap-agent-${agentId}`
				: `tap-${randomBytes(4).toString("hex")}`;

		const passphrase = cmdOpts?.passphrase ?? "";

		info(`Importing key into OWS wallet: ${walletName}`, opts);
		const imported = importOwsWalletPrivateKey(walletName, hexKey, passphrase || undefined);

		// ── Step 4: Verify address match ──────────────────────────────

		if (imported.address.toLowerCase() !== originalAddress.toLowerCase()) {
			throw new Error(
				`Address mismatch after OWS import. Original: ${originalAddress}, OWS: ${imported.address}. Aborting migration.`,
			);
		}

		// ── Step 5: Policy setup ──────────────────────────────────────

		const policyId = await setupOwsPolicy(chain, opts, {
			nonInteractive: cmdOpts?.nonInteractive,
			reuseInNonInteractive: true,
		});

		// ── Step 6: Create API key ────────────────────────────────────

		const keyName = `tap-${walletName}-${Date.now()}`;
		const apiKeyResult = createOwsApiKey({
			name: keyName,
			walletId: imported.id,
			policyId,
			passphrase,
		});
		info(`Created API key: ${keyName}`, opts);

		// ── Step 7: Verify signing works via OWS ──────────────────────

		const owsAddress = getOwsWalletAddress(walletName);
		if (owsAddress.toLowerCase() !== originalAddress.toLowerCase()) {
			throw new Error(
				`OWS wallet address verification failed. Expected: ${originalAddress}, Got: ${owsAddress}. Aborting migration.`,
			);
		}

		// ── Step 8: Update config.yaml ────────────────────────────────

		yaml.ows = {
			wallet: walletName,
			api_key: apiKeyResult.token,
		};

		const existingXmtp = (yaml.xmtp ?? {}) as Record<string, unknown>;
		yaml.xmtp = {
			...existingXmtp,
			db_encryption_key: xmtpDbEncryptionKey,
		};

		await writeYamlFileAtomic(configPath, yaml);
		info(`Updated config at ${configPath}`, opts);

		// ── Step 9: Delete raw key file ───────────────────────────────

		await unlink(keyPath);
		info("Deleted raw key file.", opts);

		// ── Done ──────────────────────────────────────────────────────

		const result = {
			status: "migrated",
			wallet: walletName,
			address: originalAddress,
			chain,
			config: configPath,
			xmtp_db_encryption_key: "persisted",
		};

		success(result, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
