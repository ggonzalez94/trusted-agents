import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portFilePath, socketFilePath, tokenFilePath } from "trusted-agents-tapd";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	TapdClient,
	TapdClientError,
	TapdNotRunningError,
	discoverTapd,
	discoverTapdUiUrl,
	tryDiscoverTapd,
} from "../../src/lib/tapd-client.js";
import {
	FAKE_TAPD_TOKEN,
	FakeError,
	type FakeTapdHandle,
	startFakeTapd,
} from "../helpers/fake-tapd-socket.ts";

async function seedTapdMetadata(dataDir: string, port: number, token: string): Promise<void> {
	await writeFile(portFilePath(dataDir), `${port}\n`, "utf-8");
	await writeFile(tokenFilePath(dataDir), token, "utf-8");
}

describe("tapd-client discovery", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-client-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("returns the per-data-dir socket path and token", async () => {
		await writeFile(tokenFilePath(dataDir), "token-abc", "utf-8");
		const info = await discoverTapd(dataDir);
		expect(info.socketPath).toBe(socketFilePath(dataDir));
		expect(info.token).toBe("token-abc");
	});

	it("throws TapdNotRunningError when token file is missing", async () => {
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("throws TapdNotRunningError when token is empty", async () => {
		await writeFile(tokenFilePath(dataDir), "", "utf-8");
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("tryDiscoverTapd returns null when not running", async () => {
		const info = await tryDiscoverTapd(dataDir);
		expect(info).toBeNull();
	});

	it("tryDiscoverTapd returns connection info when running", async () => {
		await writeFile(tokenFilePath(dataDir), "token-abc", "utf-8");
		const info = await tryDiscoverTapd(dataDir);
		expect(info?.token).toBe("token-abc");
	});

	it("discoverTapdUiUrl returns the loopback HTTP URL when port file is present", async () => {
		await seedTapdMetadata(dataDir, 4321, "token-abc");
		const ui = await discoverTapdUiUrl(dataDir);
		expect(ui).toEqual({ baseUrl: "http://127.0.0.1:4321", token: "token-abc" });
	});

	it("discoverTapdUiUrl throws TapdNotRunningError when port file is missing", async () => {
		await writeFile(tokenFilePath(dataDir), "token-abc", "utf-8");
		await expect(discoverTapdUiUrl(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("discoverTapdUiUrl throws TapdNotRunningError when port is not a positive integer", async () => {
		await seedTapdMetadata(dataDir, 0, "token-abc");
		await expect(discoverTapdUiUrl(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});
});

describe("TapdClient", () => {
	let fake: FakeTapdHandle;

	afterEach(async () => {
		await fake?.stop();
	});

	async function makeClient(
		routes: Parameters<typeof startFakeTapd>[0]["routes"],
	): Promise<TapdClient> {
		fake = await startFakeTapd({ routes });
		return await TapdClient.forDataDir(fake.dataDir);
	}

	it("sendMessage POSTs to /api/messages with bearer token over the socket", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/messages",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					peerName: "Alice",
					peerAgentId: 99,
					scope: "general-chat",
				}),
			},
		]);

		const result = await client.sendMessage({ peer: "Alice", text: "hi" });

		expect(result.peerName).toBe("Alice");
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			method: "POST",
			path: "/api/messages",
			body: { peer: "Alice", text: "hi" },
			authHeader: `Bearer ${FAKE_TAPD_TOKEN}`,
		});
	});

	it("connect POSTs to /api/connect", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-1",
					peerName: "Alice",
					peerAgentId: 99,
					status: "active",
				}),
			},
		]);

		const result = await client.connect({ inviteUrl: "tap://invite/abc", waitMs: 1000 });
		expect(result.status).toBe("active");
		expect(fake.calls[0]?.path).toBe("/api/connect");
		expect(fake.calls[0]?.body).toEqual({ inviteUrl: "tap://invite/abc", waitMs: 1000 });
	});

	it("createInvite POSTs to /api/invites with body", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/invites",
				handler: () => ({
					url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
					expiresInSeconds: 3600,
				}),
			},
		]);

		const result = await client.createInvite({ expiresInSeconds: 3600 });
		expect(result.url).toContain("trustedagents.link/connect");
		expect(result.expiresInSeconds).toBe(3600);
		expect(fake.calls[0]?.body).toEqual({ expiresInSeconds: 3600 });
	});

	it("createInvite sends empty body when no args", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/invites",
				handler: () => ({
					url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
					expiresInSeconds: 3600,
				}),
			},
		]);

		await client.createInvite();
		expect(fake.calls[0]?.body).toEqual({});
	});

	it("transfer POSTs to /api/transfers", async () => {
		const client = await makeClient([
			{ method: "POST", path: "/api/transfers", handler: () => ({ txHash: "0xabc" }) },
		]);

		const result = await client.transfer({
			asset: "usdc",
			amount: "1.50",
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000",
		});
		expect(result.txHash).toBe("0xabc");
		expect(fake.calls[0]?.path).toBe("/api/transfers");
	});

	it("requestFunds POSTs to /api/funds-requests", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/funds-requests",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					actionId: "act-1",
					peerName: "Alice",
					peerAgentId: 99,
					asset: "usdc",
					amount: "1.50",
					chain: "eip155:8453",
					toAddress: "0x0000000000000000000000000000000000000000",
				}),
			},
		]);

		await client.requestFunds({
			peer: "Alice",
			asset: "usdc",
			amount: "1.50",
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000",
		});
		expect(fake.calls[0]?.path).toBe("/api/funds-requests");
	});

	it("requestMeeting POSTs the flat body to /api/meetings", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/meetings",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					schedulingId: "sched-1",
					peerName: "Alice",
					peerAgentId: 99,
					title: "Sync",
					duration: 30,
					slotCount: 1,
				}),
			},
		]);

		await client.requestMeeting({
			peer: "Alice",
			title: "Sync",
			duration: 30,
			slots: [{ start: "2026-04-14T10:00:00Z", end: "2026-04-14T10:30:00Z" }],
			originTimezone: "UTC",
			schedulingId: "sched-1",
		});
		expect(fake.calls[0]?.path).toBe("/api/meetings");
		expect(fake.calls[0]?.body).toEqual({
			peer: "Alice",
			title: "Sync",
			duration: 30,
			slots: [{ start: "2026-04-14T10:00:00Z", end: "2026-04-14T10:30:00Z" }],
			originTimezone: "UTC",
			schedulingId: "sched-1",
		});
	});

	it("respondMeeting POSTs to /api/meetings/:id/respond", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/meetings/:id/respond",
				handler: () => ({
					resolved: true,
					schedulingId: "sched-1",
					requestId: "req-1",
					approve: true,
					report: { synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] },
				}),
			},
		]);

		await client.respondMeeting("sched-1", { approve: true });
		expect(fake.calls[0]?.path).toBe("/api/meetings/sched-1/respond");
	});

	it("cancelMeeting POSTs to /api/meetings/:id/cancel", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/meetings/:id/cancel",
				handler: () => ({
					requestId: "req-1",
					peerAgentId: 99,
					schedulingId: "sched-1",
					report: { synced: true, processed: 1, pendingRequests: [], pendingDeliveries: [] },
				}),
			},
		]);

		await client.cancelMeeting("sched-1", "bug bash");
		expect(fake.calls[0]?.path).toBe("/api/meetings/sched-1/cancel");
		expect(fake.calls[0]?.body).toEqual({ reason: "bug bash" });
	});

	it("publishGrants POSTs to /api/grants/publish", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/grants/publish",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					peerName: "Alice",
					peerAgentId: 99,
					grantCount: 1,
				}),
			},
		]);

		await client.publishGrants({
			peer: "Alice",
			grantSet: { updatedAt: "x", grants: [] },
			note: "n",
		});
		expect(fake.calls[0]?.path).toBe("/api/grants/publish");
	});

	it("requestGrants POSTs to /api/grants/request", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/grants/request",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					actionId: "act-1",
					peerName: "Alice",
					peerAgentId: 99,
					grantCount: 1,
				}),
			},
		]);

		await client.requestGrants({
			peer: "Alice",
			grantSet: { updatedAt: "x", grants: [] },
		});
		expect(fake.calls[0]?.path).toBe("/api/grants/request");
	});

	it("revokeContact POSTs to /api/contacts/:id/revoke", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/contacts/:id/revoke",
				handler: () => ({ revoked: true, connectionId: "conn-1", peer: "Alice" }),
			},
		]);

		await client.revokeContact("conn-1", "moved on");
		expect(fake.calls[0]?.path).toBe("/api/contacts/conn-1/revoke");
		expect(fake.calls[0]?.body).toEqual({ reason: "moved on" });
	});

	it("triggerSync POSTs to /daemon/sync", async () => {
		const client = await makeClient([
			{ method: "POST", path: "/daemon/sync", handler: () => ({ ok: true }) },
		]);

		await client.triggerSync();
		expect(fake.calls[0]?.path).toBe("/daemon/sync");
	});

	it("health GETs /daemon/health", async () => {
		const client = await makeClient([
			{
				method: "GET",
				path: "/daemon/health",
				handler: () => ({
					status: "ok",
					version: "0.0.0",
					uptime: 1,
					transportConnected: true,
				}),
			},
		]);

		const result = await client.health();
		expect(result.status).toBe("ok");
		expect(fake.calls[0]?.path).toBe("/daemon/health");
		expect(fake.calls[0]?.method).toBe("GET");
	});

	it("throws TapdClientError on non-2xx response", async () => {
		const client = await makeClient([
			{
				method: "POST",
				path: "/api/messages",
				handler: () => new FakeError(400, "validation_error", "missing peer"),
			},
		]);

		const err = await client.sendMessage({ peer: "", text: "x" }).catch((e) => e);
		expect(err).toBeInstanceOf(TapdClientError);
		expect((err as TapdClientError).code).toBe("validation_error");
		expect((err as TapdClientError).status).toBe(400);
	});

	it("throws TapdNotRunningError when the socket is gone", async () => {
		fake = await startFakeTapd({ routes: [] });
		const client = await TapdClient.forDataDir(fake.dataDir);
		await fake.stop();
		const err = await client.health().catch((e) => e);
		expect(err).toBeInstanceOf(TapdNotRunningError);
	});
});
