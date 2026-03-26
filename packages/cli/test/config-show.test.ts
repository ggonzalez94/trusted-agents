import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configShowCommand } from "../src/commands/config-show.js";
import * as configLoader from "../src/lib/config-loader.js";

describe("tap config show", () => {
	let tempRoot: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-config-show-"));
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
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.restoreAllMocks();
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("shows a migration warning when a legacy raw key is still present", async () => {
		const dataDir = join(tempRoot, "agent");
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await writeFile(
			join(dataDir, "identity", "agent.key"),
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"utf-8",
		);

		const config: TrustedAgentsConfig = {
			agentId: 11,
			chain: "eip155:8453",
			ows: { wallet: "", apiKey: "" },
			dataDir,
			chains: {
				"eip155:8453": {
					name: "Base",
					caip2: "eip155:8453",
					chainId: 8453,
					rpcUrl: "https://example.test/base",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
			},
			inviteExpirySeconds: 3600,
			resolveCacheTtlMs: 60000,
			resolveCacheMaxEntries: 100,
			xmtpDbEncryptionKey: undefined,
			execution: {
				mode: "eip7702",
				paymasterProvider: "circle",
			},
		};

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);

		await configShowCommand({ json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			data?: { ows?: { wallet?: string; api_key?: string }; warnings?: string[] };
		};
		expect(output.ok).toBe(true);
		expect(output.data?.ows).toEqual({ wallet: "", api_key: "" });
		expect(output.data?.warnings).toEqual([expect.stringContaining("tap migrate-wallet")]);
		expect(stderrWrites).toEqual([]);
	});

	it("loads config show without requiring a registered agent id", async () => {
		const dataDir = join(tempRoot, "unregistered-agent");
		await mkdir(dataDir, { recursive: true });
		await writeFile(
			join(dataDir, "config.yaml"),
			[
				"agent_id: -1",
				"chain: eip155:8453",
				"ows:",
				"  wallet: demo-wallet",
				"  api_key: demo-key",
			].join("\n"),
			"utf-8",
		);

		await configShowCommand({ output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { agent_id?: number; ows?: { wallet?: string; api_key?: string } };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.agent_id).toBe(-1);
		expect(output.data?.ows).toEqual({
			wallet: "demo-wallet",
			api_key: "***redacted***",
		});
	});
});
