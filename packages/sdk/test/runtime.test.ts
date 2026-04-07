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

	it("sendMessage throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.sendMessage(1, "hello")).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("sendAction throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.sendAction(1, "test/action", {})).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("connect throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.connect({ inviteUrl: "https://example.com" })).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("syncOnce throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.syncOnce()).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("stop throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.stop()).rejects.toThrow("Runtime not initialized. Call start() first.");
	});

	it("getStatus throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.getStatus()).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("listPendingRequests throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.listPendingRequests()).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("resolvePending throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.resolvePending("req-1", true)).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("publishGrants throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		const grantSet = { version: "tap-grants/v1" as const, updatedAt: "", grants: [] };
		await expect(runtime.publishGrants(1, grantSet)).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("requestGrants throws before start()", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		const grantSet = { version: "tap-grants/v1" as const, updatedAt: "", grants: [] };
		await expect(runtime.requestGrants(1, grantSet)).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("installApp throws before start() (no context)", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.installApp("nonexistent-package")).rejects.toThrow(
			"Runtime not initialized. Call start() first.",
		);
	});

	it("removeApp throws before start() (no context)", async () => {
		const runtime = await createTapRuntime({ dataDir: "/tmp/tap-sdk-test" });
		await expect(runtime.removeApp("some-app")).rejects.toThrow(
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
