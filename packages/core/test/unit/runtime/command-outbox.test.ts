import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTapCommandOutbox } from "../../../src/runtime/command-outbox.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
	);
});

describe("FileTapCommandOutbox", () => {
	it("claims queued jobs in FIFO order and stores completed results", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "tap-outbox-"));
		tempDirs.push(dataDir);
		const outbox = new FileTapCommandOutbox(dataDir);

		const first = await outbox.enqueue({
			type: "send-message",
			payload: {
				peer: "Alice",
				text: "hello",
				scope: "general-chat",
			},
		});
		const second = await outbox.enqueue({
			type: "send-message",
			payload: {
				peer: "Bob",
				text: "hi",
				scope: "general-chat",
			},
		});

		const claimedFirst = await outbox.claimNext({
			owner: "tap:test",
			staleLeaseMs: 60_000,
		});
		expect(claimedFirst?.jobId).toBe(first.jobId);

		await outbox.complete(claimedFirst!, {
			receipt: {
				received: true,
				requestId: "req-1",
				status: "received",
				receivedAt: "2026-03-10T00:00:00.000Z",
			},
			peerName: "Alice",
			peerAgentId: 1,
			scope: "general-chat",
		});

		const claimedSecond = await outbox.claimNext({
			owner: "tap:test",
			staleLeaseMs: 60_000,
		});
		expect(claimedSecond?.jobId).toBe(second.jobId);
		expect(await outbox.getResult(first.jobId)).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
	});

	it("reclaims stale processing jobs from dead owners", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "tap-outbox-"));
		tempDirs.push(dataDir);
		const outbox = new FileTapCommandOutbox(dataDir);

		const queued = await outbox.enqueue({
			type: "publish-grant-set",
			payload: {
				peer: "Bob",
				grantSet: {
					version: "tap-grants/v1",
					updatedAt: "2026-03-10T00:00:00.000Z",
					grants: [{ grantId: "grant-1", scope: "general-chat" }],
				},
			},
		});

		const claimed = await outbox.claimNext({
			owner: "tap:test",
			staleLeaseMs: 60_000,
		});
		expect(claimed?.jobId).toBe(queued.jobId);

		const staleProcessing = {
			...claimed!,
			claimedAt: "2000-01-01T00:00:00.000Z",
			claimedByPid: 999_999_999,
		};
		const processingPath = join(dataDir, "outbox", "processing", `${queued.jobId}.json`);
		await writeFile(processingPath, JSON.stringify(staleProcessing, null, "\t"), "utf-8");

		await outbox.recoverStaleProcessing({ staleLeaseMs: 1 });

		const reclaimed = await outbox.claimNext({
			owner: "tap:test",
			staleLeaseMs: 60_000,
		});
		expect(reclaimed?.jobId).toBe(queued.jobId);
	});
});
