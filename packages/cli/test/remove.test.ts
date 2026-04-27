import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as removeCommandModule from "../src/commands/remove.js";
import { defaultConfigPath } from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { buildAgentConfigYaml } from "./helpers/config-fixtures.js";
import { runCli } from "./helpers/run-cli.js";

const { TEST_ADDRESS, mockOwsProvider, mockCreateViemAccount } = vi.hoisted(() => {
	const addr = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as const;
	return {
		TEST_ADDRESS: addr,
		mockOwsProvider: vi.fn().mockImplementation(() => ({
			getAddress: vi.fn().mockResolvedValue(addr),
			signMessage: vi.fn(),
			signTypedData: vi.fn(),
			signTransaction: vi.fn(),
			signAuthorization: vi.fn(),
		})),
		mockCreateViemAccount: vi.fn().mockResolvedValue({
			address: addr,
			type: "local",
			signMessage: vi.fn(),
			signTypedData: vi.fn(),
			signTransaction: vi.fn(),
			sign: vi.fn(),
		}),
	};
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
		createSigningProviderViemAccount: mockCreateViemAccount,
	};
});

describe("tap remove", () => {
	let tmpDir: string;
	let dataDir: string;
	const { stdout: stdoutWrites } = useCapturedOutput();
	let stdinIsTTY: boolean | undefined;
	let origStdinOnce: typeof process.stdin.once;
	let origStdinSetEncoding: typeof process.stdin.setEncoding;
	let origTapOwsWallet: string | undefined;
	let origTapOwsApiKey: string | undefined;
	let origTapChain: string | undefined;
	let origTapRpcUrl: string | undefined;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-remove-test-"));
		dataDir = join(tmpDir, "agent");
		stdinIsTTY = process.stdin.isTTY;
		origStdinOnce = process.stdin.once.bind(process.stdin);
		origStdinSetEncoding = process.stdin.setEncoding.bind(process.stdin);
		origTapOwsWallet = process.env.TAP_OWS_WALLET;
		origTapOwsApiKey = process.env.TAP_OWS_API_KEY;
		origTapChain = process.env.TAP_CHAIN;
		origTapRpcUrl = process.env.TAP_RPC_URL;
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			configurable: true,
		});
		process.exitCode = undefined;
		vi.spyOn(removeCommandModule.removeRuntime, "probeRemoveNativeBalance").mockResolvedValue({
			context: null,
			probe: {
				checked: false,
				chain: null,
				chain_name: null,
				address: null,
				native_balance_wei: null,
				native_balance_eth: null,
			},
		});
		await seedAgentData(dataDir);
	});

	afterEach(async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: stdinIsTTY,
			configurable: true,
		});
		process.stdin.once = origStdinOnce;
		process.stdin.setEncoding = origStdinSetEncoding;
		process.exitCode = undefined;
		process.env.TAP_OWS_WALLET = origTapOwsWallet;
		process.env.TAP_OWS_API_KEY = origTapOwsApiKey;
		process.env.TAP_CHAIN = origTapChain;
		process.env.TAP_RPC_URL = origTapRpcUrl;
		vi.clearAllMocks();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("wires the CLI entrypoint and reports the local removal plan in dry-run mode", async () => {
		const resolvedDataDir = await realpath(dataDir);
		const result = await runCli(["--json", "--data-dir", dataDir, "remove", "--dry-run"]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.data.dry_run).toBe(true);
		expect(output.data.data_dir).toBe(resolvedDataDir);
		expect(output.data.config_path).toBe(defaultConfigPath(resolvedDataDir));
		expect(output.data.agent_id).toBe(42);
		expect(output.data.paths_to_remove).toContain(core.contactsFilePath(resolvedDataDir));
		expect(output.data.paths_to_remove).toContain(
			join(core.legacyConversationsDir(resolvedDataDir), "peer-1.json"),
		);
		expect(output.data.blocking_reasons).toEqual([]);
		expect(output.data.warnings).toContain(
			"This only removes local TAP agent data. It does not unregister the ERC-8004 agent or notify peers.",
		);
		expect(existsSync(dataDir)).toBe(true);
	});

	it("requires the explicit wipe flag before removing data", async () => {
		await removeCommandModule.removeCommand({}, { json: true, dataDir });

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("--unsafe-wipe-data-dir");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("requires --yes in non-interactive mode", async () => {
		await removeCommandModule.removeCommand({ unsafeWipeDataDir: true }, { json: true, dataDir });

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
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

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
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

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir },
		);

		expect(process.exitCode).toBe(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("owns the transport");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("wipes a TAP data dir even when it contains unknown extra files", async () => {
		await writeFile(join(dataDir, "README.md"), "stray file from some tool\n", "utf-8");
		await mkdir(join(dataDir, "scratch"), { recursive: true });
		await writeFile(join(dataDir, "scratch", "notes.txt"), "...", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(true);
		expect(existsSync(dataDir)).toBe(false);
	});

	it("removes the entire data dir in non-interactive mode when explicitly confirmed", async () => {
		const resolvedDataDir = await realpath(dataDir);
		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(true);
		expect(output.data.removed_paths).toContain(defaultConfigPath(resolvedDataDir));
		expect(existsSync(dataDir)).toBe(false);
	});

	it("wipes installed-app state and orphaned atomic-write temp files", async () => {
		const resolvedDataDir = await realpath(dataDir);

		await removeCommandModule.removeCommand({ dryRun: true }, { json: true, dataDir });
		const dryRun = JSON.parse(stdoutWrites[0]!);
		expect(dryRun.status).toBe("ok");
		expect(dryRun.data.blocking_reasons).toEqual([]);
		expect(dryRun.data.can_remove).toBe(true);
		expect(dryRun.data.paths_to_remove).toContain(core.appManifestPath(resolvedDataDir));
		expect(dryRun.data.paths_to_remove).toContain(core.appDataDirPath(resolvedDataDir, "transfer"));
		expect(dryRun.data.paths_to_remove).toContain(core.appStatePath(resolvedDataDir, "transfer"));
		expect(dryRun.data.paths_to_remove).toContain(
			`${core.contactsFilePath(resolvedDataDir)}.abc123.tmp`,
		);

		stdoutWrites.length = 0;
		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(true);
		expect(existsSync(dataDir)).toBe(false);
	});

	it("reports can_remove false for an empty directory in dry-run mode", async () => {
		const emptyDataDir = join(tmpDir, "empty-agent");
		await mkdir(emptyDataDir, { recursive: true });
		stdoutWrites.length = 0;

		await removeCommandModule.removeCommand(
			{ dryRun: true },
			{ json: true, dataDir: emptyDataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.dry_run).toBe(true);
		expect(output.data.paths_to_remove).toEqual([]);
		expect(output.data.can_remove).toBe(false);
		expect(existsSync(emptyDataDir)).toBe(true);
	});

	it("refuses external config paths for remove", async () => {
		await removeCommandModule.removeCommand(
			{ dryRun: true },
			{ json: true, dataDir, config: join(tmpDir, "outside-config.yaml") },
		);

		expect(process.exitCode).toBe(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("External config paths are not supported");
	});

	it("refuses to wipe a non-empty directory that has no TAP config.yaml", async () => {
		const strayDir = join(tmpDir, "not-a-tap-dir");
		await mkdir(strayDir, { recursive: true });
		await writeFile(join(strayDir, "README.md"), "user project\n", "utf-8");
		await writeFile(join(strayDir, "notes.txt"), "important\n", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: strayDir },
		);

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("not a TAP data dir");
		expect(existsSync(strayDir)).toBe(true);
		expect(existsSync(join(strayDir, "README.md"))).toBe(true);
	});

	it("refuses to wipe a directory whose config.yaml has neither agent_id nor chain", async () => {
		const badDataDir = join(tmpDir, "bad-agent");
		await mkdir(badDataDir, { recursive: true });
		await writeFile(
			defaultConfigPath(badDataDir),
			"some_unrelated_field: value\nanother: thing\n",
			"utf-8",
		);
		await writeFile(core.contactsFilePath(badDataDir), "[]\n", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: badDataDir },
		);

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("not a TAP data dir");
		expect(existsSync(badDataDir)).toBe(true);
	});

	it("accepts a minimal legacy config.yaml that only has a chain field", async () => {
		const legacyDataDir = join(tmpDir, "legacy-agent");
		await mkdir(legacyDataDir, { recursive: true });
		await writeFile(defaultConfigPath(legacyDataDir), "chain: eip155:8453\n", "utf-8");
		await writeFile(core.contactsFilePath(legacyDataDir), "[]\n", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: legacyDataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(true);
		expect(existsSync(legacyDataDir)).toBe(false);
	});

	it("refuses a non-TAP config.yaml whose chain value is not CAIP-2", async () => {
		const foreignDataDir = join(tmpDir, "foreign-tool");
		await mkdir(foreignDataDir, { recursive: true });
		// A different tool's config that happens to have a top-level `chain` field.
		// TAP always writes CAIP-2 (`eip155:<id>`), so a colonless value like
		// `mainnet` must not match the signature and trigger a wipe.
		await writeFile(
			defaultConfigPath(foreignDataDir),
			"chain: mainnet\nsome_other_tool_field: value\n",
			"utf-8",
		);
		await writeFile(join(foreignDataDir, "important.json"), "{}\n", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: foreignDataDir },
		);

		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("error");
		expect(output.error.message).toContain("not a TAP data dir");
		expect(existsSync(foreignDataDir)).toBe(true);
		expect(existsSync(join(foreignDataDir, "important.json"))).toBe(true);
	});

	it("accepts a chainless config.yaml that has only agent_id (config loader defaults chain)", async () => {
		const chainlessDataDir = join(tmpDir, "chainless-agent");
		await mkdir(chainlessDataDir, { recursive: true });
		await writeFile(defaultConfigPath(chainlessDataDir), "agent_id: 42\n", "utf-8");
		await writeFile(core.contactsFilePath(chainlessDataDir), "[]\n", "utf-8");

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: chainlessDataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(true);
		expect(existsSync(chainlessDataDir)).toBe(false);
	});

	it("does not enumerate the data dir when removal is going to be blocked", async () => {
		const strayDir = join(tmpDir, "stray-tree");
		await mkdir(join(strayDir, "nested", "deeper"), { recursive: true });
		await writeFile(join(strayDir, "file1.txt"), "x", "utf-8");
		await writeFile(join(strayDir, "nested", "file2.txt"), "y", "utf-8");
		await writeFile(join(strayDir, "nested", "deeper", "file3.txt"), "z", "utf-8");

		await removeCommandModule.removeCommand({ dryRun: true }, { json: true, dataDir: strayDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.can_remove).toBe(false);
		expect(output.data.blocking_reasons[0]).toContain("not a TAP data dir");
		// The tree under the non-TAP dir must not be enumerated — otherwise a
		// typo'd --data-dir pointing at $HOME or a node_modules tree would hang.
		expect(output.data.paths_to_remove).toEqual([]);
	});

	it("resolves symlinked data dirs to the real TAP directory before removing", async () => {
		const actualDataDir = join(tmpDir, "actual-agent");
		const linkedDataDir = join(tmpDir, "linked-agent");
		await seedAgentData(actualDataDir);
		await symlink(actualDataDir, linkedDataDir);
		const resolvedActualDataDir = await realpath(actualDataDir);
		stdoutWrites.length = 0;

		await removeCommandModule.removeCommand(
			{ unsafeWipeDataDir: true, yes: true },
			{ json: true, dataDir: linkedDataDir },
		);

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.data_dir).toBe(resolvedActualDataDir);
		expect(output.data.removed_paths).toContain(defaultConfigPath(resolvedActualDataDir));
		expect(existsSync(actualDataDir)).toBe(false);
	});

	it("offers optional balance transfer before interactive wipe", async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
		});
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		const answers = ["no\n", "no\n"];
		process.stdin.once = ((_: string, handler: (data: string) => void) => {
			handler(answers.shift() ?? "no\n");
			return process.stdin;
		}) as typeof process.stdin.once;

		vi.spyOn(removeCommandModule.removeRuntime, "probeRemoveNativeBalance").mockResolvedValue({
			context: {
				config: {} as never,
				chain: "eip155:8453",
				chainConfig: { name: "Base" } as never,
				address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
				nativeBalanceWei: 1000000000000000000n,
				nativeBalanceEth: "1",
			},
			probe: {
				checked: true,
				chain: "eip155:8453",
				chain_name: "Base",
				address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
				native_balance_wei: "1000000000000000000",
				native_balance_eth: "1",
			},
		});

		await removeCommandModule.removeCommand({ unsafeWipeDataDir: true }, { json: true, dataDir });

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.status).toBe("ok");
		expect(output.data.removed).toBe(false);
		expect(output.data.aborted).toBe(true);
		expect(output.data.funds_transfer.attempted).toBe(false);
		expect(output.data.funds_transfer.skipped_reason).toContain("declined");
		expect(existsSync(dataDir)).toBe(true);
	});

	it("probes balance from the target data dir instead of env overrides", async () => {
		process.env.TAP_OWS_WALLET = "env-override-wallet";
		process.env.TAP_OWS_API_KEY = "env-override-key";
		process.env.TAP_CHAIN = "taiko";
		const getBalance = vi.fn().mockResolvedValue(1n);
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			getBalance,
		} as never);

		const result = await removeCommandModule.probeRemoveNativeBalance(
			dataDir,
			defaultConfigPath(dataDir),
		);

		expect(result.probe.checked).toBe(true);
		expect(result.probe.chain).toBe("eip155:8453");
		expect(result.probe.address).toBe(TEST_ADDRESS);
		expect(getBalance).toHaveBeenCalledWith({ address: TEST_ADDRESS });
	});

	it("refreshes the native balance right before transferring funds", async () => {
		const freshBalanceWei = 2_000_000_000_000_000_000n;
		const gasEstimate = 21_000n;
		const gasPrice = 100n;
		const sendTransaction = vi.fn().mockResolvedValue("0x1234");
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			getBalance: vi.fn().mockResolvedValue(freshBalanceWei),
			estimateGas: vi.fn().mockResolvedValue(gasEstimate),
			estimateFeesPerGas: vi.fn().mockResolvedValue({ gasPrice }),
			waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
		} as never);
		vi.spyOn(core, "buildChainWalletClient").mockReturnValue({
			chain: { id: 8453 },
			sendTransaction,
		} as never);

		const result = await removeCommandModule.transferRemainingNativeBalance(
			{
				config: {
					ows: { wallet: "test-wallet", apiKey: "test-key" },
					chain: "eip155:8453",
				} as never,
				chain: "eip155:8453",
				chainConfig: { name: "Base" } as never,
				address: TEST_ADDRESS,
				nativeBalanceWei: 1_000_000_000_000_000_000n,
				nativeBalanceEth: "1",
			},
			"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
		);

		const expectedAmountWei = freshBalanceWei - gasEstimate * gasPrice;
		expect(sendTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				value: expectedAmountWei,
			}),
		);
		expect(result.amountWei).toBe(expectedAmountWei);
	});
});

async function seedAgentData(dataDir: string): Promise<void> {
	await mkdir(join(dataDir, "identity"), { recursive: true });
	await mkdir(core.legacyConversationsDir(dataDir), { recursive: true });
	await mkdir(join(dataDir, "xmtp"), { recursive: true });
	await mkdir(core.appDataDirPath(dataDir, "transfer"), { recursive: true });
	await writeFile(
		defaultConfigPath(dataDir),
		`${buildAgentConfigYaml({ agentId: 42, wallet: "test-wallet", apiKey: "test-api-key" })}\n`,
		"utf-8",
	);
	await writeFile(core.contactsFilePath(dataDir), "[]\n", "utf-8");
	await writeFile(join(core.legacyConversationsDir(dataDir), "peer-1.json"), "[]\n", "utf-8");
	await writeFile(join(dataDir, "xmtp", "agent.db3"), "", "utf-8");
	await writeFile(join(dataDir, "pending-invites.json"), "[]\n", "utf-8");
	await writeFile(
		core.appManifestPath(dataDir),
		JSON.stringify({ apps: { transfer: { package: "tap-app-transfer" } } }),
		"utf-8",
	);
	await writeFile(core.appStatePath(dataDir, "transfer"), JSON.stringify({ grants: [] }), "utf-8");
	// Simulate an orphaned atomic-write temp file from an interrupted store write.
	await writeFile(`${core.contactsFilePath(dataDir)}.abc123.tmp`, "[]\n", "utf-8");
}
