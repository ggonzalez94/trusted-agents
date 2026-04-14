import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermesStatusCommand } from "../src/commands/hermes.js";

describe("Hermes commands", () => {
	let hermesHome: string;
	let dataDir: string;
	let stdoutWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let originalHermesHome: string | undefined;
	let originalDataDir: string | undefined;

	beforeEach(async () => {
		hermesHome = await mkdtemp(join(tmpdir(), "tap-hermes-command-"));
		dataDir = await mkdtemp(join(tmpdir(), "tap-hermes-data-"));
		stdoutWrites = [];
		origStdoutWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		originalHermesHome = process.env.HERMES_HOME;
		process.env.HERMES_HOME = hermesHome;
		originalDataDir = process.env.TAP_DATA_DIR;
		process.env.TAP_DATA_DIR = dataDir;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.env.HERMES_HOME = originalHermesHome;
		process.env.TAP_DATA_DIR = originalDataDir;
		process.exitCode = undefined;
		await rm(hermesHome, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	it("hermes status forwards to daemon status and reports tapd not running", async () => {
		// No tapd port/token files exist in dataDir, so the underlying daemon
		// status command should return { running: false, data_dir }.
		await hermesStatusCommand({ hermesHome }, { json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data: { running: boolean; data_dir: string };
		};
		expect(output.status).toBe("ok");
		expect(output.data.running).toBe(false);
		expect(output.data.data_dir).toBe(dataDir);
	});
});
