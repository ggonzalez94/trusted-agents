import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import YAML from "yaml";
import { resolveChainAlias } from "../lib/chains.js";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import {
	createOwsApiKey,
	createOwsPolicy,
	ensureOwsInstalled,
	findCompatiblePolicies,
	getOwsWalletAddress,
	importOwsWalletPrivateKey,
} from "../lib/ows.js";
import { promptInput } from "../lib/prompt.js";
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

		const configContent = await readFile(configPath, "utf-8");
		const yaml = (YAML.parse(configContent) ?? {}) as Record<string, unknown>;

		// Already migrated?
		const existingOws = yaml.ows as { wallet?: string; api_key?: string } | undefined;
		if (existingOws?.wallet && existingOws?.api_key) {
			throw new Error("This agent already has OWS wallet configuration. Migration is not needed.");
		}

		// agent.key must exist
		const keyPath = join(dataDir, "identity", "agent.key");
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

		const policyChains = [chain];
		if (chain !== "eip155:8453") {
			policyChains.push("eip155:8453");
		}

		let policyId: string;
		const compatible = findCompatiblePolicies(chain);

		if (compatible.length > 0 && !cmdOpts?.nonInteractive) {
			info("\nCompatible OWS policies:", opts);
			for (let i = 0; i < compatible.length; i++) {
				const p = compatible[i]!;
				info(`  ${i + 1}. ${p.name} (chains: ${p.chains.join(", ")})`, opts);
			}

			const choice = await promptInput("\nReuse an existing policy? [1/2/.../no]: ");
			if (choice && choice !== "no") {
				const idx = Number.parseInt(choice, 10) - 1;
				if (idx >= 0 && idx < compatible.length) {
					policyId = compatible[idx]!.id;
					info(`Using policy: ${policyId}`, opts);
				} else {
					policyId = createNewPolicy(policyChains);
					info(`Created policy: ${policyId}`, opts);
				}
			} else {
				policyId = createNewPolicy(policyChains);
				info(`Created policy: ${policyId}`, opts);
			}
		} else {
			// Non-interactive or no compatible policies
			if (compatible.length > 0) {
				// Non-interactive: reuse first compatible
				policyId = compatible[0]!.id;
				info(`Using existing policy: ${policyId}`, opts);
			} else {
				policyId = createNewPolicy(policyChains);
				info(`Created policy: ${policyId}`, opts);
			}
		}

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

		await writeFile(configPath, YAML.stringify(yaml), "utf-8");
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
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function createNewPolicy(chains: string[]): string {
	const policyId = `tap-${randomBytes(4).toString("hex")}`;
	const oneYearFromNow = new Date();
	oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

	createOwsPolicy({
		id: policyId,
		chains,
		expiresAt: oneYearFromNow.toISOString(),
	});

	return policyId;
}
