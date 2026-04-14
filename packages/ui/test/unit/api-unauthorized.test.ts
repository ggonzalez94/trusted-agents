import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TapdApiError, TapdClient, TapdUnauthorizedError } from "../../lib/api.js";

/**
 * F2.2 — 401 from tapd must throw `TapdUnauthorizedError`, a subclass of
 * `TapdApiError`, so the dashboard can narrow on it via `instanceof` and
 * transition to the re-auth screen. All other non-2xx statuses still throw
 * the plain `TapdApiError`.
 */
describe("TapdClient 401 handling", () => {
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

	it("throws TapdUnauthorizedError on 401", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }), {
				status: 401,
			}),
		);
		const client = new TapdClient("http://localhost:6810");
		const error = await client.getIdentity().catch((e) => e);
		expect(error).toBeInstanceOf(TapdUnauthorizedError);
		// Subclass relationship preserved: consumers that only know about the
		// base error type still match.
		expect(error).toBeInstanceOf(TapdApiError);
		expect((error as TapdUnauthorizedError).status).toBe(401);
		expect((error as TapdUnauthorizedError).code).toBe("unauthorized");
		expect((error as TapdUnauthorizedError).message).toBe("bad token");
		expect((error as TapdUnauthorizedError).name).toBe("TapdUnauthorizedError");
	});

	it("throws TapdUnauthorizedError on 401 even with no error body", async () => {
		fetchMock.mockResolvedValue(new Response("", { status: 401, statusText: "Unauthorized" }));
		const client = new TapdClient("http://localhost:6810");
		const error = await client.listContacts().catch((e) => e);
		expect(error).toBeInstanceOf(TapdUnauthorizedError);
		expect((error as TapdUnauthorizedError).code).toBe("unknown_error");
	});

	it("throws plain TapdApiError (NOT unauthorized) on 404", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
				status: 404,
			}),
		);
		const client = new TapdClient("http://localhost:6810");
		const error = await client.getIdentity().catch((e) => e);
		expect(error).toBeInstanceOf(TapdApiError);
		expect(error).not.toBeInstanceOf(TapdUnauthorizedError);
		expect((error as TapdApiError).status).toBe(404);
	});

	it("throws plain TapdApiError on 500", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), {
				status: 500,
			}),
		);
		const client = new TapdClient("http://localhost:6810");
		const error = await client.listPending().catch((e) => e);
		expect(error).toBeInstanceOf(TapdApiError);
		expect(error).not.toBeInstanceOf(TapdUnauthorizedError);
		expect((error as TapdApiError).status).toBe(500);
	});

	it("throws plain TapdApiError on 403 (not 401)", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "forbidden", message: "nope" } }), {
				status: 403,
			}),
		);
		const client = new TapdClient("http://localhost:6810");
		const error = await client.listContacts().catch((e) => e);
		expect(error).toBeInstanceOf(TapdApiError);
		expect(error).not.toBeInstanceOf(TapdUnauthorizedError);
	});
});
