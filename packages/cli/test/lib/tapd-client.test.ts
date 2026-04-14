import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TapdClient,
	TapdClientError,
	TapdNotRunningError,
	discoverTapd,
	tryDiscoverTapd,
} from "../../src/lib/tapd-client.js";

async function seedTapdMetadata(dataDir: string, port: number, token: string): Promise<void> {
	await writeFile(join(dataDir, ".tapd.port"), `${port}\n`, "utf-8");
	await writeFile(join(dataDir, ".tapd-token"), token, "utf-8");
}

describe("tapd-client discovery", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-client-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("returns connection info when both files are present", async () => {
		await seedTapdMetadata(dataDir, 4321, "token-abc");
		const info = await discoverTapd(dataDir);
		expect(info).toEqual({ baseUrl: "http://127.0.0.1:4321", token: "token-abc" });
	});

	it("throws TapdNotRunningError when port file is missing", async () => {
		await writeFile(join(dataDir, ".tapd-token"), "token-abc", "utf-8");
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("throws TapdNotRunningError when token file is missing", async () => {
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("throws TapdNotRunningError when port is not a positive integer", async () => {
		await seedTapdMetadata(dataDir, 0, "token-abc");
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("throws TapdNotRunningError when token is empty", async () => {
		await seedTapdMetadata(dataDir, 4321, "");
		await expect(discoverTapd(dataDir)).rejects.toBeInstanceOf(TapdNotRunningError);
	});

	it("tryDiscoverTapd returns null when not running", async () => {
		const info = await tryDiscoverTapd(dataDir);
		expect(info).toBeNull();
	});

	it("tryDiscoverTapd returns connection info when running", async () => {
		await seedTapdMetadata(dataDir, 4321, "token-abc");
		const info = await tryDiscoverTapd(dataDir);
		expect(info?.baseUrl).toBe("http://127.0.0.1:4321");
	});
});

interface FetchCall {
	url: string;
	method: string;
	body?: string;
	authHeader?: string;
}

function setupFetchSpy(handler: (url: string, init: RequestInit) => Response): FetchCall[] {
	const calls: FetchCall[] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input.toString();
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? init.body : undefined,
			authHeader: headers.Authorization,
		});
		return handler(url, init ?? {});
	});
	vi.stubGlobal("fetch", fetchMock);
	return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("TapdClient", () => {
	const info = { baseUrl: "http://127.0.0.1:4321", token: "token-abc" };

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sendMessage POSTs to /api/messages with bearer token", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				receipt: { messageId: "m-1", status: "delivered" },
				peerName: "Alice",
				peerAgentId: 99,
				scope: "general-chat",
			}),
		);
		const client = new TapdClient(info);

		const result = await client.sendMessage({ peer: "Alice", text: "hi" });

		expect(result.peerName).toBe("Alice");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/messages");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.authHeader).toBe("Bearer token-abc");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ peer: "Alice", text: "hi" });
	});

	it("connect POSTs to /api/connect", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				connectionId: "conn-1",
				peerName: "Alice",
				peerAgentId: 99,
				status: "active",
			}),
		);
		const client = new TapdClient(info);

		const result = await client.connect({ inviteUrl: "tap://invite/abc", waitMs: 1000 });
		expect(result.status).toBe("active");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/connect");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			inviteUrl: "tap://invite/abc",
			waitMs: 1000,
		});
	});

	it("createInvite POSTs to /api/invites", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
				expiresInSeconds: 3600,
			}),
		);
		const client = new TapdClient(info);

		const result = await client.createInvite({ expiresInSeconds: 3600 });
		expect(result.url).toContain("trustedagents.link/connect");
		expect(result.expiresInSeconds).toBe(3600);
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/invites");
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ expiresInSeconds: 3600 });
	});

	it("createInvite sends empty body when no args", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
				expiresInSeconds: 3600,
			}),
		);
		const client = new TapdClient(info);

		await client.createInvite();
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({});
	});

	it("transfer POSTs to /api/transfers", async () => {
		const calls = setupFetchSpy(() => jsonResponse({ txHash: "0xabc" }));
		const client = new TapdClient(info);

		const result = await client.transfer({
			asset: "usdc",
			amount: "1.50",
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000",
		});
		expect(result.txHash).toBe("0xabc");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/transfers");
	});

	it("requestFunds POSTs to /api/funds-requests", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				receipt: { messageId: "m-1", status: "delivered" },
				actionId: "act-1",
				peerName: "Alice",
				peerAgentId: 99,
				asset: "usdc",
				amount: "1.50",
				chain: "eip155:8453",
				toAddress: "0x0000000000000000000000000000000000000000",
			}),
		);
		const client = new TapdClient(info);

		await client.requestFunds({
			peer: "Alice",
			asset: "usdc",
			amount: "1.50",
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000",
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/funds-requests");
	});

	it("requestMeeting POSTs to /api/meetings", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				receipt: { messageId: "m-1", status: "delivered" },
				schedulingId: "sched-1",
				peerName: "Alice",
				peerAgentId: 99,
				title: "Sync",
				duration: 30,
				slotCount: 1,
			}),
		);
		const client = new TapdClient(info);

		await client.requestMeeting({
			peer: "Alice",
			proposal: {
				type: "scheduling/propose",
				schedulingId: "sched-1",
				title: "Sync",
				duration: 30,
				slots: [{ start: "2026-04-14T10:00:00Z", end: "2026-04-14T10:30:00Z" }],
				originTimezone: "UTC",
			},
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/meetings");
	});

	it("respondMeeting POSTs to /api/meetings/:id/respond", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				resolved: true,
				schedulingId: "sched-1",
				requestId: "req-1",
				approve: true,
				report: { synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] },
			}),
		);
		const client = new TapdClient(info);

		await client.respondMeeting("sched-1", { approve: true });
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/meetings/sched-1/respond");
	});

	it("cancelMeeting POSTs to /api/meetings/:id/cancel", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				requestId: "req-1",
				peerAgentId: 99,
				schedulingId: "sched-1",
				report: { synced: true, processed: 1, pendingRequests: [], pendingDeliveries: [] },
			}),
		);
		const client = new TapdClient(info);

		await client.cancelMeeting("sched-1", "bug bash");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/meetings/sched-1/cancel");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ reason: "bug bash" });
	});

	it("publishGrants POSTs to /api/grants/publish", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				receipt: { messageId: "m-1", status: "delivered" },
				peerName: "Alice",
				peerAgentId: 99,
				grantCount: 1,
			}),
		);
		const client = new TapdClient(info);

		await client.publishGrants({
			peer: "Alice",
			grantSet: { updatedAt: "x", grants: [] },
			note: "n",
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/grants/publish");
	});

	it("requestGrants POSTs to /api/grants/request", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				receipt: { messageId: "m-1", status: "delivered" },
				actionId: "act-1",
				peerName: "Alice",
				peerAgentId: 99,
				grantCount: 1,
			}),
		);
		const client = new TapdClient(info);

		await client.requestGrants({
			peer: "Alice",
			grantSet: { updatedAt: "x", grants: [] },
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/grants/request");
	});

	it("revokeContact POSTs to /api/contacts/:id/revoke", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({ revoked: true, connectionId: "conn-1", peer: "Alice" }),
		);
		const client = new TapdClient(info);

		await client.revokeContact("conn-1", "moved on");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/api/contacts/conn-1/revoke");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ reason: "moved on" });
	});

	it("triggerSync POSTs to /daemon/sync", async () => {
		const calls = setupFetchSpy(() => jsonResponse({ ok: true }));
		const client = new TapdClient(info);

		await client.triggerSync();
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/daemon/sync");
	});

	it("health GETs /daemon/health", async () => {
		const calls = setupFetchSpy(() =>
			jsonResponse({
				status: "ok",
				version: "0.0.0",
				uptime: 1,
				transportConnected: true,
			}),
		);
		const client = new TapdClient(info);

		const result = await client.health();
		expect(result.status).toBe("ok");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4321/daemon/health");
		expect(calls[0]?.method).toBe("GET");
	});

	it("throws TapdClientError on non-2xx response", async () => {
		setupFetchSpy(() =>
			jsonResponse({ error: { code: "validation_error", message: "missing peer" } }, 400),
		);
		const client = new TapdClient(info);

		const err = await client.sendMessage({ peer: "", text: "x" }).catch((e) => e);
		expect(err).toBeInstanceOf(TapdClientError);
		expect((err as TapdClientError).code).toBe("validation_error");
		expect((err as TapdClientError).status).toBe(400);
	});
});
