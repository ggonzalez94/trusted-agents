import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermesStatusCommand } from "../src/commands/hermes.js";
import { saveTapHermesPluginConfig } from "../src/hermes/config.js";

describe("Hermes commands", () => {
	let hermesHome: string;
	let stdoutWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let originalHermesHome: string | undefined;

	beforeEach(async () => {
		hermesHome = await mkdtemp(join(tmpdir(), "tap-hermes-command-"));
		stdoutWrites = [];
		origStdoutWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		originalHermesHome = process.env.HERMES_HOME;
		process.env.HERMES_HOME = hermesHome;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		if (originalHermesHome === undefined) {
			delete process.env.HERMES_HOME;
		} else {
			process.env.HERMES_HOME = originalHermesHome;
		}
		process.exitCode = undefined;
		await rm(hermesHome, { recursive: true, force: true });
	});

	it("errors when offline status is asked for an unknown identity", async () => {
		await saveTapHermesPluginConfig(hermesHome, {
			identities: [
				{
					name: "default",
					dataDir: "/tmp/tap-agent",
					reconcileIntervalMinutes: 10,
				},
			],
		});

		await hermesStatusCommand({ hermesHome, identity: "defualt" }, { json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.message).toContain("Unknown TAP identity: defualt");
		expect(process.exitCode).toBeGreaterThan(0);
	});
});
