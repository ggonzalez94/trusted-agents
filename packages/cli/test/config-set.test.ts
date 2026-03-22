import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { configSetCommand } from "../src/commands/config-set.js";

describe("config set", () => {
	let tmpDir: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-set-test-"));
		stdoutWrites = [];
		stderrWrites = [];
		process.exitCode = undefined;
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

		await mkdir(tmpDir, { recursive: true });
		await writeFile(
			join(tmpDir, "config.yaml"),
			[
				"agent_id: 1",
				"chain: eip155:8453",
				"execution:",
				"  mode: eip7702",
				"  paymaster_provider: circle",
				"xmtp:",
				"  env: production",
				"",
			].join("\n"),
			"utf-8",
		);
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("normalizes camelCase execution keys to the yaml schema", async () => {
		await configSetCommand("execution.paymasterProvider", "candide", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readFile(join(tmpDir, "config.yaml"), "utf-8");
		expect(config).toContain("paymaster_provider: candide");
		expect(config).not.toContain("paymasterProvider:");
	});

	it("resolves chain aliases when updating the chain", async () => {
		await configSetCommand("chain", "base-sepolia", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readFile(join(tmpDir, "config.yaml"), "utf-8");
		expect(config).toContain("chain: eip155:84532");
	});

	it("only coerces known numeric config keys", async () => {
		await configSetCommand("resolve_cache_ttl_ms", "60000", {
			json: true,
			dataDir: tmpDir,
		});
		await configSetCommand("xmtp.env", "1234", {
			json: true,
			dataDir: tmpDir,
		});

		const config = YAML.parse(await readFile(join(tmpDir, "config.yaml"), "utf-8")) as {
			resolve_cache_ttl_ms: unknown;
			xmtp?: { env?: unknown };
		};
		expect(config.resolve_cache_ttl_ms).toBe(60000);
		expect(config.xmtp?.env).toBe("1234");
	});

	it("normalizes camelCase IPFS keys to the yaml schema", async () => {
		await configSetCommand("ipfs.tackApiUrl", "https://tack.example.test", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readFile(join(tmpDir, "config.yaml"), "utf-8");
		expect(config).toContain("tack_api_url: https://tack.example.test");
		expect(config).not.toContain("tackApiUrl:");
	});

	it("rejects split-brain config and data-dir overrides", async () => {
		const otherDir = join(tmpDir, "other-agent");
		await mkdir(otherDir, { recursive: true });
		await writeFile(join(otherDir, "config.yaml"), "agent_id: 9\nchain: eip155:84532\n", "utf-8");

		await configSetCommand("chain", "base", {
			json: true,
			dataDir: tmpDir,
			config: join(otherDir, "config.yaml"),
		});

		expect(process.exitCode).toBe(1);
		expect(stdoutWrites.join("")).toContain("Config path must match the TAP data dir config");
	});
});
