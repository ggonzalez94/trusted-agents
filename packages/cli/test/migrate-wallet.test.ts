import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteWallet } from "@open-wallet-standard/core";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { migrateWalletCommand } from "../src/commands/migrate-wallet.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { useOwsArtifactCleanup } from "./helpers/ows-cleanup.js";
import { runCli } from "./helpers/run-cli.js";

// Well-known Hardhat test key — never use in production
const TEST_PRIVATE_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = privateKeyToAccount(`0x${TEST_PRIVATE_KEY}`).address;

describe("tap migrate-wallet", () => {
	let tmpDir: string;
	let dataDir: string;
	let configPath: string;
	let keyPath: string;
	const { stdout: stdoutWrites } = useCapturedOutput();
	const { trackOwsArtifacts } = useOwsArtifactCleanup();

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-migrate-test-"));
		dataDir = join(tmpDir, "data");
		configPath = join(dataDir, "config.yaml");
		keyPath = join(dataDir, "identity", "agent.key");

		// Clean up stale OWS wallets from previous test runs that may have
		// failed before afterEach cleanup (wallet names are deterministic)
		for (const name of ["tap-agent-42", "tap-agent-99"]) {
			try {
				deleteWallet(name);
			} catch (_) {
				/* ignore — wallet may not exist */
			}
		}
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Set up a legacy data dir with config.yaml + identity/agent.key */
	async function setupLegacyAgent(agentId: number): Promise<void> {
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await mkdir(join(dataDir, "xmtp"), { recursive: true });

		await writeFile(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });

		const yamlConfig = {
			agent_id: agentId,
			chain: "eip155:8453",
		};
		await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");
	}

	it("should migrate a legacy agent to OWS", async () => {
		await setupLegacyAgent(42);

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true, passphrase: "" });

		// Config should have OWS block
		const updatedConfig = YAML.parse(await readFile(configPath, "utf-8"));
		expect(updatedConfig.ows).toBeDefined();
		expect(updatedConfig.ows.wallet).toBe("tap-agent-42");
		expect(updatedConfig.ows.api_key).toMatch(/^ows_key_/);

		// XMTP DB encryption key should be persisted (legacy formula)
		expect(updatedConfig.xmtp).toBeDefined();
		expect(updatedConfig.xmtp.db_encryption_key).toMatch(/^0x[0-9a-fA-F]{64}$/);

		// Verify it matches the legacy derivation
		const expectedKey = keccak256(toHex(`xmtp-db-encryption:0x${TEST_PRIVATE_KEY}`));
		expect(updatedConfig.xmtp.db_encryption_key).toBe(expectedKey);

		// agent.key should be deleted
		expect(existsSync(keyPath)).toBe(false);

		// JSON output should indicate success
		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.status).toBe("migrated");
		expect(output.data.wallet).toBe("tap-agent-42");
		expect(output.data.address).toBe(TEST_ADDRESS);

		trackOwsArtifacts(updatedConfig);
	});

	it("should fail when config does not exist", async () => {
		await mkdir(dataDir, { recursive: true });

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true });

		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("No config found");
	});

	it("should fail when agent.key does not exist", async () => {
		await mkdir(join(dataDir, "identity"), { recursive: true });

		const yamlConfig = { agent_id: 42, chain: "eip155:8453" };
		await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true });

		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("No key file found");
	});

	it("should fail when already migrated (OWS block exists)", async () => {
		await setupLegacyAgent(42);

		// Add OWS block to config
		const configContent = YAML.parse(await readFile(configPath, "utf-8"));
		configContent.ows = { wallet: "existing-wallet", api_key: "ows_key_existing" };
		await writeFile(configPath, YAML.stringify(configContent), "utf-8");

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true });

		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("already has OWS wallet configuration");

		// agent.key should NOT be deleted
		expect(existsSync(keyPath)).toBe(true);
	});

	it("should handle 0x-prefixed keys", async () => {
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await mkdir(join(dataDir, "xmtp"), { recursive: true });

		// Write key with 0x prefix
		await writeFile(keyPath, `0x${TEST_PRIVATE_KEY}`, { mode: 0o600 });

		const yamlConfig = { agent_id: 99, chain: "eip155:8453" };
		await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true, passphrase: "" });

		const updatedConfig = YAML.parse(await readFile(configPath, "utf-8"));
		expect(updatedConfig.ows).toBeDefined();
		expect(updatedConfig.ows.wallet).toBe("tap-agent-99");
		expect(existsSync(keyPath)).toBe(false);

		trackOwsArtifacts(updatedConfig);
	});

	it("should preserve existing config fields during migration", async () => {
		await setupLegacyAgent(7);

		// Add extra fields to config
		const configContent = YAML.parse(await readFile(configPath, "utf-8"));
		configContent.invite_expiry_seconds = 3600;
		configContent.execution = { mode: "eip7702" };
		await writeFile(configPath, YAML.stringify(configContent), "utf-8");

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true, passphrase: "" });

		const updatedConfig = YAML.parse(await readFile(configPath, "utf-8"));

		// Original fields preserved
		expect(updatedConfig.agent_id).toBe(7);
		expect(updatedConfig.chain).toBe("eip155:8453");
		expect(updatedConfig.invite_expiry_seconds).toBe(3600);
		expect(updatedConfig.execution.mode).toBe("eip7702");

		// OWS added
		expect(updatedConfig.ows).toBeDefined();
		expect(updatedConfig.ows.wallet).toBe("tap-agent-7");

		trackOwsArtifacts(updatedConfig);
	});

	it("should use a random wallet name for unregistered agents (agent_id: -1)", async () => {
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await mkdir(join(dataDir, "xmtp"), { recursive: true });

		await writeFile(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });

		const yamlConfig = { agent_id: -1, chain: "eip155:8453" };
		await writeFile(configPath, YAML.stringify(yamlConfig), "utf-8");

		await migrateWalletCommand({ json: true, dataDir }, { nonInteractive: true, passphrase: "" });

		const updatedConfig = YAML.parse(await readFile(configPath, "utf-8"));
		expect(updatedConfig.ows.wallet).toMatch(/^tap-[0-9a-f]{8}$/);
		expect(existsSync(keyPath)).toBe(false);

		trackOwsArtifacts(updatedConfig);
	});

	it("should work through the CLI entrypoint", async () => {
		await setupLegacyAgent(10);

		const result = await runCli([
			"--json",
			"--data-dir",
			dataDir,
			"migrate-wallet",
			"--passphrase",
			"",
			"--non-interactive",
		]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.status).toBe("ok");
		expect(output.data.status).toBe("migrated");

		const updatedConfig = YAML.parse(await readFile(configPath, "utf-8"));
		trackOwsArtifacts(updatedConfig);
	});
});
