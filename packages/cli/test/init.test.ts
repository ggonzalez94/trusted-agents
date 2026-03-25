import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePolicy, deleteWallet, listApiKeys, revokeApiKey } from "@open-wallet-standard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand } from "../src/commands/init.js";
import { runCli } from "./helpers/run-cli.js";

describe("tap init", () => {
	let tmpDir: string;
	let configPath: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	// Track OWS artifacts for cleanup
	const createdWallets: string[] = [];
	const createdPolicies: string[] = [];
	const createdApiKeyIds: string[] = [];

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-init-test-"));
		configPath = join(tmpDir, "config.yaml");
		stdoutWrites = [];
		stderrWrites = [];
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			stderrWrites.push(chunk);
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;

		// Clean up OWS artifacts
		for (const keyId of createdApiKeyIds) {
			try {
				revokeApiKey(keyId);
			} catch (_) {
				/* ignore */
			}
		}
		for (const policyId of createdPolicies) {
			try {
				deletePolicy(policyId);
			} catch (_) {
				/* ignore */
			}
		}
		for (const walletName of createdWallets) {
			try {
				deleteWallet(walletName);
			} catch (_) {
				/* ignore */
			}
		}
		createdApiKeyIds.length = 0;
		createdPolicies.length = 0;
		createdWallets.length = 0;

		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Track OWS artifacts created during a test for cleanup. */
	function trackOwsArtifacts(yaml: Record<string, unknown>) {
		const ows = yaml.ows as { wallet?: string } | undefined;
		if (ows?.wallet) {
			createdWallets.push(ows.wallet);
		}
		// Find API keys and policies created during the test
		try {
			const keys = listApiKeys();
			for (const k of keys) {
				if (k.name && typeof k.name === "string" && k.name.startsWith("tap-")) {
					createdApiKeyIds.push(k.id);
				}
			}
		} catch (_) {
			/* ignore */
		}
	}

	it("should create config file and directory structure with OWS wallet", async () => {
		const dataDir = join(tmpDir, "data");

		await initCommand(
			{
				json: true,
				config: configPath,
				dataDir,
			},
			{ nonInteractive: true },
		);

		// Config file created
		expect(existsSync(configPath)).toBe(true);
		const configContent = await readFile(configPath, "utf-8");
		const yaml = YAML.parse(configContent);
		expect(yaml.agent_id).toBe(-1);
		expect(yaml.chain).toBe("eip155:8453");

		// OWS config present
		expect(yaml.ows).toBeDefined();
		expect(yaml.ows.wallet).toBeTruthy();
		expect(yaml.ows.api_key).toMatch(/^ows_key_/);

		// XMTP encryption key present
		expect(yaml.xmtp).toBeDefined();
		expect(yaml.xmtp.db_encryption_key).toMatch(/^0x[0-9a-fA-F]{64}$/);

		// Directories created
		expect(existsSync(join(dataDir, "conversations"))).toBe(true);
		expect(existsSync(join(dataDir, "xmtp"))).toBe(true);

		// JSON output
		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.chain).toBe("eip155:8453");
		expect(output.data.wallet).toBeTruthy();

		trackOwsArtifacts(yaml);
	});

	it("should not overwrite existing config", async () => {
		const dataDir = join(tmpDir, "data");

		// Run init twice
		await initCommand({ json: true, config: configPath, dataDir }, { nonInteractive: true });
		const firstConfig = await readFile(configPath, "utf-8");
		trackOwsArtifacts(YAML.parse(firstConfig));

		stdoutWrites = [];
		await initCommand({ json: true, config: configPath, dataDir });
		const secondConfig = await readFile(configPath, "utf-8");

		// Config should not be regenerated
		expect(firstConfig).toBe(secondConfig);
	});

	it("should create config inside an explicit data dir without reusing legacy config", async () => {
		const dataDir = join(tmpDir, "isolated-data");

		await initCommand(
			{
				json: true,
				dataDir,
			},
			{ nonInteractive: true },
		);

		expect(existsSync(join(dataDir, "config.yaml"))).toBe(true);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.data.config).toBe(join(dataDir, "config.yaml"));

		const configContent = await readFile(join(dataDir, "config.yaml"), "utf-8");
		trackOwsArtifacts(YAML.parse(configContent));
	});

	it("reuses the saved chain in output when init is rerun", async () => {
		const dataDir = join(tmpDir, "existing-chain");

		await initCommand(
			{
				json: true,
				dataDir,
			},
			{ chain: "taiko", nonInteractive: true },
		);

		const configContent = await readFile(join(dataDir, "config.yaml"), "utf-8");
		trackOwsArtifacts(YAML.parse(configContent));

		stdoutWrites = [];
		await initCommand({
			json: true,
			dataDir,
		});

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.data.chain).toBe("eip155:167000");
		expect(output.data.chain_name).toBe("Taiko");
	});

	it("uses a provided wallet name in non-interactive mode", async () => {
		const dataDir = join(tmpDir, "wallet-name");
		const walletName = `tap-init-test-${Date.now()}`;

		await initCommand(
			{
				json: true,
				dataDir,
			},
			{ wallet: walletName, passphrase: "test-pass", nonInteractive: true },
		);

		const configContent = await readFile(join(dataDir, "config.yaml"), "utf-8");
		const yaml = YAML.parse(configContent);
		expect(yaml.ows.wallet).toBe(walletName);
		expect(yaml.ows.api_key).toMatch(/^ows_key_/);

		trackOwsArtifacts(yaml);
	});

	it("respects the init --chain flag through the CLI entrypoint", async () => {
		const dataDir = join(tmpDir, "cli-entrypoint");
		const result = await runCli([
			"--json",
			"--data-dir",
			dataDir,
			"init",
			"--chain",
			"base",
			"--non-interactive",
		]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.data.chain).toBe("eip155:8453");
		expect(output.data.chain_name).toBe("Base");

		const configContent = await readFile(join(dataDir, "config.yaml"), "utf-8");
		trackOwsArtifacts(YAML.parse(configContent));
	});
});
