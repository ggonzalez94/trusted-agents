import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRequestJournal } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalListCommand } from "../src/commands/journal-list.js";
import { journalShowCommand } from "../src/commands/journal-show.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { UNREGISTERED_AGENT_CONFIG_YAML } from "./helpers/config-fixtures.js";

async function makeAgentDir(root: string): Promise<string> {
	const dataDir = join(root, "agent");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "config.yaml"), UNREGISTERED_AGENT_CONFIG_YAML, "utf-8");
	return dataDir;
}

async function seedJournal(dataDir: string): Promise<void> {
	const journal = new FileRequestJournal(dataDir);
	await journal.putOutbound({
		requestId: "req-out-1",
		requestKey: "outbound:req-out-1",
		direction: "outbound",
		kind: "request",
		method: "connection/request",
		peerAgentId: 1,
		status: "pending",
	});
	await journal.putOutbound({
		requestId: "req-out-2",
		requestKey: "outbound:req-out-2",
		direction: "outbound",
		kind: "request",
		method: "message/send",
		peerAgentId: 2,
		status: "queued",
	});
	await journal.claimInbound({
		requestId: "req-in-1",
		requestKey: "inbound:req-in-1",
		direction: "inbound",
		kind: "request",
		method: "action/request",
		peerAgentId: 3,
		status: "pending",
	});
	await journal.putOutbound({
		requestId: "req-done",
		requestKey: "outbound:req-done",
		direction: "outbound",
		kind: "request",
		method: "message/send",
		peerAgentId: 4,
		status: "completed",
	});
}

describe("tap journal list", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-journal-list-"));
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("returns an empty list when no journal entries exist", async () => {
		const dataDir = await makeAgentDir(tempRoot);

		await journalListCommand({}, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: unknown[]; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.entries).toEqual([]);
		expect(output.data?.count).toBe(0);
		expect(stderrWrites).toEqual([]);
	});

	it("lists all journal entries when no filters are given", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({}, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.count).toBe(4);
		const ids = output.data?.entries?.map((e) => e.request_id);
		expect(ids).toContain("req-out-1");
		expect(ids).toContain("req-out-2");
		expect(ids).toContain("req-in-1");
		expect(ids).toContain("req-done");
	});

	it("filters by direction outbound", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({ direction: "outbound" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string; direction: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		const entries = output.data?.entries ?? [];
		expect(entries.every((e) => e.direction === "outbound")).toBe(true);
		expect(entries.map((e) => e.request_id)).not.toContain("req-in-1");
		expect(output.data?.count).toBe(3);
	});

	it("filters by direction inbound", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({ direction: "inbound" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.count).toBe(1);
		expect(output.data?.entries?.[0]?.request_id).toBe("req-in-1");
	});

	it("filters by status pending", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({ status: "pending" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string; status: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		const entries = output.data?.entries ?? [];
		expect(entries.every((e) => e.status === "pending")).toBe(true);
		expect(entries.map((e) => e.request_id)).toContain("req-out-1");
		expect(entries.map((e) => e.request_id)).toContain("req-in-1");
		expect(entries.map((e) => e.request_id)).not.toContain("req-out-2");
		expect(entries.map((e) => e.request_id)).not.toContain("req-done");
	});

	it("filters by status queued", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({ status: "queued" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.count).toBe(1);
		expect(output.data?.entries?.[0]?.request_id).toBe("req-out-2");
	});

	it("filters by method", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await seedJournal(dataDir);

		await journalListCommand({ method: "connection/request" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { entries?: Array<{ request_id: string; method: string }>; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.count).toBe(1);
		expect(output.data?.entries?.[0]?.request_id).toBe("req-out-1");
		expect(output.data?.entries?.[0]?.method).toBe("connection/request");
	});
});

describe("tap journal show", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-journal-show-"));
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("shows a single entry by requestId", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId: "req-show-1",
			requestKey: "outbound:req-show-1",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 7,
			status: "pending",
		});

		await journalShowCommand("req-show-1", { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: {
				request_id: string;
				request_key: string;
				direction: string;
				kind: string;
				method: string;
				peer_agent_id: number;
				status: string;
			};
		};
		expect(output.status).toBe("ok");
		expect(output.data?.request_id).toBe("req-show-1");
		expect(output.data?.request_key).toBe("outbound:req-show-1");
		expect(output.data?.direction).toBe("outbound");
		expect(output.data?.kind).toBe("request");
		expect(output.data?.method).toBe("connection/request");
		expect(output.data?.peer_agent_id).toBe(7);
		expect(output.data?.status).toBe("pending");
	});

	it("errors NOT_FOUND for unknown requestId", async () => {
		const dataDir = await makeAgentDir(tempRoot);

		await journalShowCommand("nonexistent-id", { output: "json", dataDir });

		expect(process.exitCode).toBe(4);
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("NOT_FOUND");
	});
});
