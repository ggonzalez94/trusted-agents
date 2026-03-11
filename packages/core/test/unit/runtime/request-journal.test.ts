import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";

const tempDirs: string[] = [];

async function createJournal() {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-request-journal-"));
	tempDirs.push(dataDir);
	return new FileRequestJournal(dataDir);
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
	);
});

describe("FileRequestJournal", () => {
	it("claims inbound requests idempotently by request key", async () => {
		const journal = await createJournal();

		const first = await journal.claimInbound({
			requestId: "req-1",
			requestKey: "inbound:peer:nonce-1",
			direction: "inbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 42,
			metadata: { note: "first" },
		});
		const duplicate = await journal.claimInbound({
			requestId: "req-2",
			requestKey: "inbound:peer:nonce-1",
			direction: "inbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 42,
		});

		expect(first.duplicate).toBe(false);
		expect(duplicate.duplicate).toBe(true);
		expect(duplicate.entry.requestId).toBe("req-1");
		expect(await journal.getByRequestId("req-2")).toBeNull();
	});

	it("updates outbound entries in place by request id", async () => {
		const journal = await createJournal();

		await journal.putOutbound({
			requestId: "req-1",
			requestKey: "outbound:req-1",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 7,
			status: "pending",
		});
		await journal.putOutbound({
			requestId: "req-1",
			requestKey: "outbound:req-1",
			direction: "outbound",
			kind: "result",
			method: "action/result",
			peerAgentId: 7,
			correlationId: "action-1",
			status: "acked",
			metadata: { updated: true },
		});

		expect(await journal.listPending("outbound")).toEqual([
			expect.objectContaining({
				requestId: "req-1",
				kind: "result",
				method: "action/result",
				status: "acked",
				correlationId: "action-1",
				metadata: { updated: true },
			}),
		]);
	});

	it("filters completed entries from pending lists", async () => {
		const journal = await createJournal();

		await journal.putOutbound({
			requestId: "out-1",
			requestKey: "outbound:out-1",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 1,
			status: "pending",
		});
		await journal.claimInbound({
			requestId: "in-1",
			requestKey: "inbound:in-1",
			direction: "inbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 2,
		});
		await journal.updateStatus("out-1", "completed");

		expect(await journal.listPending()).toEqual([
			expect.objectContaining({
				requestId: "in-1",
				direction: "inbound",
				status: "pending",
			}),
		]);
		expect(await journal.listPending("outbound")).toEqual([]);
		expect(await journal.listPending("inbound")).toEqual([
			expect.objectContaining({
				requestId: "in-1",
			}),
		]);
	});

	it("completes an inbound request before recording an outbound result", async () => {
		const journal = await createJournal();

		await journal.claimInbound({
			requestId: "in-1",
			requestKey: "inbound:in-1",
			direction: "inbound",
			kind: "request",
			method: "action/request",
			peerAgentId: 2,
			status: "pending",
		});

		await journal.updateStatus("in-1", "completed");
		await journal.putOutbound({
			requestId: "out-1",
			requestKey: "outbound:out-1",
			direction: "outbound",
			kind: "result",
			method: "action/result",
			peerAgentId: 2,
			correlationId: "in-1",
			status: "pending",
			metadata: { queued: true },
		});

		expect(await journal.getByRequestId("in-1")).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		expect(await journal.getByRequestId("out-1")).toEqual(
			expect.objectContaining({
				status: "pending",
				correlationId: "in-1",
				metadata: { queued: true },
			}),
		);
	});
});
