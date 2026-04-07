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
