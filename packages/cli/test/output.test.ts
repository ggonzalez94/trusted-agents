import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
		success({ foo: "bar" }, { output: "json" });
		expect(stdoutWrites).toHaveLength(1);
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.status).toBe("ok");
		expect(parsed.ok).toBe(true);
		expect(parsed.data).toEqual({ foo: "bar" });
		expect(parsed.metadata.format).toBe("json");
	});

	it("should include meta with duration when startTime provided", async () => {
		const { success } = await import("../src/lib/output.js");
		const startTime = Date.now() - 100;
		success({ x: 1 }, { output: "json", commandPath: "tap config show" }, startTime);
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.status).toBe("ok");
		expect(parsed.metadata).toBeDefined();
		expect(parsed.metadata.duration_ms).toBeGreaterThanOrEqual(0);
		expect(parsed.metadata.command).toBe("tap config show");
		expect(parsed.metadata.format).toBe("json");
	});

	it("should output error envelope in JSON mode", async () => {
		const { error } = await import("../src/lib/output.js");
		error("TEST_ERROR", "something went wrong", { output: "json" });
		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.status).toBe("error");
		expect(parsed.ok).toBe(false);
		expect(parsed.error.code).toBe("TEST_ERROR");
		expect(parsed.error.message).toBe("something went wrong");
		expect(parsed.metadata.format).toBe("json");
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

	it("should pretty-print object arrays in plain mode", async () => {
		const { success } = await import("../src/lib/output.js");
		success(
			{
				id: "conv-1",
				messages: [{ content: "hello", scope: "message/send" }],
			},
			{ plain: true },
		);
		expect(stdoutWrites.join("")).toContain('"content": "hello"');
		expect(stdoutWrites.join("")).not.toContain("[object Object]");
	});

	it("applies field selection and pagination before writing JSON envelopes", async () => {
		const { success } = await import("../src/lib/output.js");
		success(
			{
				contacts: [
					{ name: "Alpha", status: "active", connection_id: "c1" },
					{ name: "Beta", status: "pending", connection_id: "c2" },
				],
			},
			{ output: "json", select: "name,status", limit: 1, offset: 0 },
		);

		const parsed = JSON.parse(stdoutWrites[0]!);
		expect(parsed.data).toEqual({
			contacts: [{ name: "Alpha", status: "active" }],
		});
		expect(parsed.metadata.pagination).toEqual({
			limit: 1,
			offset: 0,
			returned: 1,
			total: 2,
		});
		expect(parsed.metadata.selected_fields).toEqual(["name", "status"]);
	});
});
