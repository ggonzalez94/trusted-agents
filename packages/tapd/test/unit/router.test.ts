import { describe, expect, it, vi } from "vitest";
import { Router } from "../../src/http/router.js";

describe("Router", () => {
	it("dispatches GET requests to matching handlers", async () => {
		const router = new Router();
		const handler = vi.fn(async () => ({ ok: true }));
		router.add("GET", "/api/identity", handler);

		const result = await router.dispatch("GET", "/api/identity");
		expect(handler).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});

	it("returns null when no route matches", async () => {
		const router = new Router();
		expect(await router.dispatch("GET", "/missing")).toBeNull();
	});

	it("matches path parameters and passes them to the handler", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>) => params);
		router.add("GET", "/api/contacts/:id", handler);

		const result = await router.dispatch("GET", "/api/contacts/abc-123");
		expect(handler).toHaveBeenCalledWith({ id: "abc-123" }, undefined);
		expect(result).toEqual({ id: "abc-123" });
	});

	it("matches multiple path parameters", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>) => params);
		router.add("GET", "/api/conversations/:id/messages/:msg", handler);

		await router.dispatch("GET", "/api/conversations/c1/messages/m2");
		expect(handler).toHaveBeenCalledWith({ id: "c1", msg: "m2" }, undefined);
	});

	it("differentiates by method", async () => {
		const router = new Router();
		const get = vi.fn(async () => "get");
		const post = vi.fn(async () => "post");
		router.add("GET", "/api/x", get);
		router.add("POST", "/api/x", post);

		expect(await router.dispatch("GET", "/api/x")).toBe("get");
		expect(await router.dispatch("POST", "/api/x")).toBe("post");
	});

	it("ignores trailing slashes", async () => {
		const router = new Router();
		router.add("GET", "/api/x", async () => "ok");
		expect(await router.dispatch("GET", "/api/x/")).toBe("ok");
	});

	it("passes body to handler when provided", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>, body: unknown) => ({
			params,
			body,
		}));
		router.add("POST", "/api/x", handler);

		const result = await router.dispatch("POST", "/api/x", { hello: "world" });
		expect(result).toEqual({ params: {}, body: { hello: "world" } });
	});
});
