import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We test the output module by capturing stdout/stderr writes
describe("output", () => {
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
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

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
	});

	it("should output JSON envelope on success with --json", async () => {
		const { success } = await import("../src/lib/output.js");
		success({ foo: "bar" }, { json: true });
		expect(stdoutWrites).toHaveLength(1);
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.ok).toBe(true);
		expect(parsed.data).toEqual({ foo: "bar" });
	});

	it("should include meta with duration when startTime provided", async () => {
		const { success } = await import("../src/lib/output.js");
		const startTime = Date.now() - 100;
		success({ x: 1 }, { json: true }, startTime);
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.ok).toBe(true);
		expect(parsed.meta).toBeDefined();
		expect(parsed.meta.duration_ms).toBeGreaterThanOrEqual(0);
		expect(parsed.meta.version).toBe("0.1.0");
	});

	it("should output error envelope in JSON mode", async () => {
		const { error } = await import("../src/lib/output.js");
		error("TEST_ERROR", "something went wrong", { json: true });
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.ok).toBe(false);
		expect(parsed.error.code).toBe("TEST_ERROR");
		expect(parsed.error.message).toBe("something went wrong");
	});

	it("should write error to stderr in plain mode", async () => {
		const { error } = await import("../src/lib/output.js");
		error("TEST_ERROR", "something went wrong", { plain: true });
		expect(stdoutWrites).toHaveLength(0);
		expect(stderrWrites[0]).toContain("something went wrong");
	});

	it("should output verbose messages to stderr when verbose flag set", async () => {
		const { verbose } = await import("../src/lib/output.js");
		verbose("debug info", { verbose: true });
		expect(stderrWrites[0]).toContain("[verbose] debug info");
	});

	it("should suppress verbose messages when flag not set", async () => {
		const { verbose } = await import("../src/lib/output.js");
		verbose("debug info", {});
		expect(stderrWrites).toHaveLength(0);
	});

	it("should suppress info messages when quiet flag set", async () => {
		const { info } = await import("../src/lib/output.js");
		info("some info", { quiet: true });
		expect(stderrWrites).toHaveLength(0);
	});

	it("should output info to stderr when not quiet", async () => {
		const { info } = await import("../src/lib/output.js");
		info("some info", {});
		expect(stderrWrites[0]).toContain("some info");
	});
});
