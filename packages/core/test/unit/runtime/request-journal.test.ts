import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackDir } = useTempDirs();

async function createJournal() {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-request-journal-"));
	trackDir(dataDir);
	return new FileRequestJournal(dataDir);
}

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
			status: "pending",
			metadata: { updated: true },
		});

		expect(await journal.listPending("outbound")).toEqual([
			expect.objectContaining({
				requestId: "req-1",
				kind: "result",
				method: "action/result",
				status: "pending",
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

	it("listQueued returns only queued entries", async () => {
		const journal = await createJournal();

		await journal.putOutbound({
			requestId: "req-queued",
			requestKey: "outbound:req-queued",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 1,
			status: "queued",
		});
		await journal.putOutbound({
			requestId: "req-pending",
			requestKey: "outbound:req-pending",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 2,
			status: "pending",
		});
		await journal.putOutbound({
			requestId: "req-done",
			requestKey: "outbound:req-done",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 3,
			status: "completed",
		});

		const queued = await journal.listQueued();
		expect(queued.map((e) => e.requestId)).toEqual(["req-queued"]);
	});

	it("listPending returns only pending entries (not queued)", async () => {
		const journal = await createJournal();

		await journal.putOutbound({
			requestId: "req-queued",
			requestKey: "outbound:req-queued",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 1,
			status: "queued",
		});
		await journal.putOutbound({
			requestId: "req-pending",
			requestKey: "outbound:req-pending",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 2,
			status: "pending",
		});
		await journal.putOutbound({
			requestId: "req-done",
			requestKey: "outbound:req-done",
			direction: "outbound",
			kind: "request",
			method: "message/send",
			peerAgentId: 3,
			status: "completed",
		});

		const pending = await journal.listPending();
		expect(pending.map((e) => e.requestId)).toEqual(["req-pending"]);
	});

	it("persists metadata.lastError with incrementing attempts", async () => {
		const journal = await createJournal();
		await journal.putOutbound({
			requestId: "req-err-1",
			requestKey: "outbound:req-err-1",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 42,
			status: "pending",
		});

		await journal.updateMetadata("req-err-1", {
			lastError: { message: "xmtp timeout", at: "2026-04-10T00:00:00Z", attempts: 1 },
		});
		await journal.updateMetadata("req-err-1", {
			lastError: { message: "network unreachable", at: "2026-04-10T00:01:00Z", attempts: 2 },
		});

		const fetched = await journal.getByRequestId("req-err-1");
		expect(fetched?.metadata?.lastError?.attempts).toBe(2);
		expect(fetched?.metadata?.lastError?.message).toBe("network unreachable");
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
