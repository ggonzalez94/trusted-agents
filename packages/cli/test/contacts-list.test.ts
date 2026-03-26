import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contactsListCommand } from "../src/commands/contacts-list.js";

describe("tap contacts list", () => {
	let tempRoot: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-contacts-list-"));
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
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("returns an empty contact list even before registration is complete", async () => {
		const dataDir = join(tempRoot, "agent");
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

		await contactsListCommand({ output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { contacts?: unknown[] };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.contacts).toEqual([]);
		expect(stderrWrites).toEqual([]);
	});
});
