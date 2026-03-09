import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeCommand } from "../src/commands/remove.js";
import { runCli } from "./helpers/run-cli.js";

describe("tap remove", () => {
	let tmpDir: string;
	let dataDir: string;
	let stdoutWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;
	let stdinIsTTY: boolean | undefined;
	let origStdinOnce: typeof process.stdin.once;
	let origStdinSetEncoding: typeof process.stdin.setEncoding;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-remove-test-"));
		dataDir = join(tmpDir, "agent");
		stdoutWrites = [];
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		stdinIsTTY = process.stdin.isTTY;
		origStdinOnce = process.stdin.once.bind(process.stdin);
		origStdinSetEncoding = process.stdin.setEncoding.bind(process.stdin);
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			configurable: true,
		});
		process.exitCode = undefined;
		await seedAgentData(dataDir);
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		Object.defineProperty(process.stdin, "isTTY", {
			value: stdinIsTTY,
			configurable: true,
		});
		process.stdin.once = origStdinOnce;
		process.stdin.setEncoding = origStdinSetEncoding;
		process.exitCode = undefined;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("wires the CLI entrypoint and reports the local removal plan in dry-run mode", async () => {
		const resolvedDataDir = await realpath(dataDir);
		const result = await runCli(["--json", "--data-dir", dataDir, "remove", "--dry-run"]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.data.dry_run).toBe(true);
		expect(output.data.data_dir).toBe(resolvedDataDir);
		expect(output.data.config_path).toBe(join(resolvedDataDir, "config.yaml"));
		expect(output.data.agent_id).toBe(42);
		expect(output.data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(output.data.paths_to_remove).toContain(join(resolvedDataDir, "contacts.json"));
		expect(output.data.paths_to_remove).toContain(
			join(resolvedDataDir, "conversations", "peer-1.json"),
		);
		expect(output.data.blocking_reasons).toEqual([]);
		expect(output.data.warnings).toContain(
			"This only removes local TAP agent data. It does not unregister the ERC-8004 agent or notify peers.",
		);
		expect(existsSync(dataDir)).toBe(true);
	});

	it("requires the explicit wipe flag before removing data", async () => {
		await removeCommand({}, { json: true, dataDir });

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(false);
		expect(output.error.message).toContain("--unsafe-wipe-data-dir");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("requires --yes in non-interactive mode", async () => {
		await removeCommand({ unsafeWipeDataDir: true }, { json: true, dataDir });

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(false);
		expect(output.error.message).toContain("--yes");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("still prompts in interactive mode even when --yes is present", async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
		});
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.once = ((_: string, handler: (data: string) => void) => {
			handler("no\n");
			return process.stdin;
		}) as typeof process.stdin.once;

		await removeCommand({ unsafeWipeDataDir: true, yes: true }, { json: true, dataDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.removed).toBe(false);
		expect(output.data.aborted).toBe(true);
		expect(existsSync(dataDir)).toBe(true);
	});

	it("refuses removal when a live transport owner lock exists", async () => {
		await writeFile(
			join(dataDir, ".transport.lock"),
			JSON.stringify(
				{
					pid: process.pid,
					owner: "tap message listen",
					acquiredAt: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf-8",
		);

		await removeCommand({ unsafeWipeDataDir: true, yes: true }, { json: true, dataDir });

		expect(process.exitCode).toBe(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(false);
		expect(output.error.message).toContain("owns the transport");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("refuses to wipe a data dir that contains non-TAP top-level entries", async () => {
		await writeFile(join(dataDir, "README.md"), "not tap-managed\n", "utf-8");

		await removeCommand({ unsafeWipeDataDir: true, yes: true }, { json: true, dataDir });

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(false);
		expect(output.error.message).toContain("non-TAP top-level entries");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("removes the entire data dir in non-interactive mode when explicitly confirmed", async () => {
		const resolvedDataDir = await realpath(dataDir);
		await removeCommand({ unsafeWipeDataDir: true, yes: true }, { json: true, dataDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.removed).toBe(true);
		expect(output.data.removed_paths).toContain(join(resolvedDataDir, "config.yaml"));
		expect(output.data.removed_paths).toContain(join(resolvedDataDir, "identity", "agent.key"));
		expect(existsSync(dataDir)).toBe(false);
	});

	it("reports can_remove false for an empty directory in dry-run mode", async () => {
		const emptyDataDir = join(tmpDir, "empty-agent");
		await mkdir(emptyDataDir, { recursive: true });
		stdoutWrites = [];

		await removeCommand({ dryRun: true }, { json: true, dataDir: emptyDataDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.dry_run).toBe(true);
		expect(output.data.paths_to_remove).toEqual([]);
		expect(output.data.can_remove).toBe(false);
		expect(existsSync(emptyDataDir)).toBe(true);
	});

	it("refuses external config paths for remove", async () => {
		await removeCommand(
			{ dryRun: true },
			{ json: true, dataDir, config: join(tmpDir, "outside-config.yaml") },
		);

		expect(process.exitCode).toBe(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(false);
		expect(output.error.message).toContain("External config paths are not supported");
	});

	it("refuses data dirs with unexpected top-level entries", async () => {
		await writeFile(join(dataDir, "keep.txt"), "keep\n", "utf-8");

		await removeCommand({ dryRun: true }, { json: true, dataDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.can_remove).toBe(false);
		expect(output.data.blocking_reasons[0]).toContain("non-TAP top-level entries");
		expect(output.data.paths_to_remove).not.toContain(join(dataDir, "keep.txt"));

		stdoutWrites = [];
		await removeCommand({ unsafeWipeDataDir: true, yes: true }, { json: true, dataDir });

		const blocked = JSON.parse(stdoutWrites[0]!);
		expect(blocked.ok).toBe(false);
		expect(blocked.error.message).toContain("non-TAP top-level entries");
		expect(existsSync(join(dataDir, "keep.txt"))).toBe(true);
		expect(existsSync(join(dataDir, "config.yaml"))).toBe(true);
	});

	it("resolves symlinked data dirs to the real TAP directory before removing", async () => {
		const actualDataDir = join(tmpDir, "actual-agent");
		const linkedDataDir = join(tmpDir, "linked-agent");
		await seedAgentData(actualDataDir);
		await symlink(actualDataDir, linkedDataDir);
		const resolvedActualDataDir = await realpath(actualDataDir);
		stdoutWrites = [];

		await removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: linkedDataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.data_dir).toBe(resolvedActualDataDir);
		expect(output.data.removed_paths).toContain(join(resolvedActualDataDir, "config.yaml"));
		expect(existsSync(actualDataDir)).toBe(false);
	});
});

async function seedAgentData(dataDir: string): Promise<void> {
	await mkdir(join(dataDir, "identity"), { recursive: true });
	await mkdir(join(dataDir, "conversations"), { recursive: true });
	await mkdir(join(dataDir, "xmtp"), { recursive: true });
	await writeFile(join(dataDir, "config.yaml"), "agent_id: 42\nchain: eip155:8453\n", "utf-8");
	await writeFile(
		join(dataDir, "identity", "agent.key"),
		"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
		"utf-8",
	);
	await writeFile(join(dataDir, "contacts.json"), "[]\n", "utf-8");
	await writeFile(join(dataDir, "conversations", "peer-1.json"), "[]\n", "utf-8");
	await writeFile(join(dataDir, "xmtp", "agent.db3"), "", "utf-8");
	await writeFile(join(dataDir, "pending-invites.json"), "[]\n", "utf-8");
}
