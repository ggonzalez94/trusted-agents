import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configShowCommand } from "../src/commands/config-show.js";
import * as configLoader from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { buildTestConfig } from "./helpers/config-fixtures.js";

describe("tap config show", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-config-show-"));
		process.exitCode = undefined;
	});

	afterEach(async () => {
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

		const config = buildTestConfig({ agentId: 11, ows: { wallet: "", apiKey: "" }, dataDir });

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);

		await configShowCommand({ json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { ows?: { wallet?: string; api_key?: string }; warnings?: string[] };
		};
		expect(output.status).toBe("ok");
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
