import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TapdApiError, TapdClient } from "../../lib/api.js";

describe("TapdClient", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		sessionStorage.clear();
		sessionStorage.setItem("tapd-token", "test-token");
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("includes bearer token on GET requests", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					agentId: 42,
					chain: "eip155:8453",
					address: "",
					displayName: "",
					dataDir: "",
				}),
				{ status: 200 },
			),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.getIdentity();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-token");
	});

	it("returns parsed JSON on success", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					agentId: 42,
					chain: "eip155:8453",
					address: "0xabc",
					displayName: "Alice",
					dataDir: "/tmp",
				}),
				{ status: 200 },
			),
		);
		const client = new TapdClient("http://localhost:6810");
		const result = await client.getIdentity();
		expect(result.agentId).toBe(42);
		expect(result.displayName).toBe("Alice");
	});

	it("throws TapdApiError on non-2xx with error code", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ error: { code: "not_found", message: "nope" } }),
				{ status: 404 },
			),
		);
		const client = new TapdClient("http://localhost:6810");
		const error = await client.getIdentity().catch((e) => e);
		expect(error).toBeInstanceOf(TapdApiError);
		expect(error).toMatchObject({ code: "not_found", status: 404 });
	});

	it("approves a pending item with POST and note", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ resolved: true }), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.approvePending("req-1", "looks good");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("/api/pending/req-1/approve");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			note: "looks good",
		});
	});

	it("approves without a note sends an empty body object", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ resolved: true }), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.approvePending("req-1");

		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({});
	});

	it("denies a pending item with reason", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ resolved: true }), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.denyPending("req-2", "policy");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("/api/pending/req-2/deny");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			reason: "policy",
		});
	});

	it("marks a conversation as read", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.markConversationRead("conv-1");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("/api/conversations/conv-1/mark-read");
		expect((init as RequestInit).method).toBe("POST");
	});

	it("lists contacts", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify([{ connectionId: "a" }]), {
				status: 200,
			}),
		);
		const client = new TapdClient("http://localhost:6810");
		const result = await client.listContacts();
		expect(result).toHaveLength(1);
	});

	it("URL-encodes path parameters", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(null), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.getContact("conn/with/slashes");

		const url = fetchMock.mock.calls[0][0] as string;
		expect(url).toContain("conn%2Fwith%2Fslashes");
	});

	it("omits Authorization header when no token is stored", async () => {
		sessionStorage.clear();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify([]), { status: 200 }),
		);
		const client = new TapdClient("http://localhost:6810");
		await client.listContacts();
		const headers = (fetchMock.mock.calls[0][1] as RequestInit)
			.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});
});
