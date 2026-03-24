import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand } from "../src/commands/init.js";

describe("tap init --private-key", () => {
	let tmpDir: string;
	let configPath: string;
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;
	let stdoutWrites: string[];

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-init-import-"));
		configPath = join(tmpDir, "config.yaml");
		process.env.TAP_OWS_VAULT_PATH = join(tmpDir, "ows-vault");
		stdoutWrites = [];
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		Reflect.deleteProperty(process.env, "TAP_OWS_VAULT_PATH");
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should import an existing private key into Open Wallet", async () => {
		const dataDir = join(tmpDir, "data");
		const knownKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

		await initCommand({ json: true, config: configPath, dataDir }, { privateKey: knownKey });

		const keyfile = join(dataDir, "identity", "agent.key");
		expect(existsSync(keyfile)).toBe(false);

		const yaml = YAML.parse(await readFile(configPath, "utf-8"));
		expect(yaml.wallet.provider).toBe("open-wallet");
		expect(yaml.wallet.name).toMatch(/^tap-/);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(output.data.wallet_status).toBe("imported");
	});

	it("should accept a key with 0x prefix", async () => {
		const dataDir = join(tmpDir, "data");
		const knownKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

		await initCommand({ json: true, config: configPath, dataDir }, { privateKey: knownKey });

		const yaml = YAML.parse(await readFile(configPath, "utf-8"));
		expect(yaml.wallet.provider).toBe("open-wallet");
		expect(yaml.xmtp.db_encryption_key).toMatch(/^0x[0-9a-fA-F]{64}$/);
	});

	it("should replace the selected wallet when a new private key is provided", async () => {
		const dataDir = join(tmpDir, "data");

		await initCommand({ json: true, config: configPath, dataDir });
		const firstWallet = (
			YAML.parse(await readFile(configPath, "utf-8")) as { wallet: { id?: string } }
		).wallet.id;

		stdoutWrites = [];
		const importKey = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		await initCommand({ json: true, config: configPath, dataDir }, { privateKey: importKey });

		const secondWallet = (
			YAML.parse(await readFile(configPath, "utf-8")) as { wallet: { id?: string } }
		).wallet.id;
		expect(secondWallet).not.toBe(firstWallet);
	});
});
