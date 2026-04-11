import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapRuntime, createTapRuntime } from "../src/index.js";

describe("createTapRuntime", () => {
	it("returns a TapRuntime instance", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		expect(runtime).toBeInstanceOf(TapRuntime);
	});

	it("is an EventEmitter", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		expect(typeof runtime.on).toBe("function");
		expect(typeof runtime.emit).toBe("function");
		expect(typeof runtime.removeListener).toBe("function");
	});
});

describe("TapRuntime before start()", () => {
	it("listApps returns empty array before init", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		expect(runtime.listApps()).toEqual([]);
	});

	const grantSet = { version: "tap-grants/v1" as const, updatedAt: "", grants: [] };

	it.each<[string, (r: TapRuntime) => Promise<unknown>]>([
		["sendMessage", (r) => r.sendMessage(1, "hello")],
		["sendAction", (r) => r.sendAction(1, "test/action", {})],
		["connect", (r) => r.connect({ inviteUrl: "https://example.com" })],
		["syncOnce", (r) => r.syncOnce()],
		["stop", (r) => r.stop()],
		["getStatus", (r) => r.getStatus()],
		["listPendingRequests", (r) => r.listPendingRequests()],
		["resolvePending", (r) => r.resolvePending("req-1", true)],
		["publishGrants", (r) => r.publishGrants(1, grantSet)],
		["requestGrants", (r) => r.requestGrants(1, grantSet)],
		["installApp", (r) => r.installApp("nonexistent-package")],
		["removeApp", (r) => r.removeApp("some-app")],
	])("%s throws before start()", async (_name, callMethod) => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(callMethod(runtime)).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});
});

describe("TapRuntime event subscription", () => {
	it("supports event listener registration", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		const events: unknown[] = [];
		runtime.on("event", (payload) => events.push(payload));
		runtime.emit("event", { type: "test" });
		expect(events).toEqual([{ type: "test" }]);
	});

	it("supports log event listener", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		const logs: unknown[] = [];
		runtime.on("log", (entry) => logs.push(entry));
		runtime.emit("log", { level: "info", message: "test" });
		expect(logs).toEqual([{ level: "info", message: "test" }]);
	});
});

describe("TapRuntime init", () => {
	it("uses preloaded config instead of reloading from disk", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "tap-sdk-runtime-"));
		const runtime = await createTapRuntime({
			dataDir,
			preloadedConfig: {
				agentId: 123,
				chain: "eip155:8453",
				ows: { wallet: "wallet-1", apiKey: "ows_key_test" },
				dataDir,
				chains: {},
				inviteExpirySeconds: 3600,
				resolveCacheTtlMs: 60_000,
				resolveCacheMaxEntries: 128,
			},
			createSigningProvider: async () =>
				({
					getAddress: async () => "0x0000000000000000000000000000000000000001",
					signMessage: async () => "0x1",
					signTypedData: async () => "0x1",
					signTransaction: async () => "0x1",
					signAuthorization: async () => ({}),
				}) as never,
			contextOptions: {
				transport: {
					setHandlers: () => {},
					send: async () => ({
						received: true,
						requestId: "test",
						status: "received",
						receivedAt: new Date().toISOString(),
					}),
					isReachable: async () => true,
				},
			},
		});

		await runtime.init();

		expect(runtime.config.agentId).toBe(123);
		expect(runtime.config.dataDir).toBe(dataDir);
	});
});
