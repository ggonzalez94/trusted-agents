import { describe, expect, it, vi } from "vitest";
import { createDaemonControlRoutes } from "../../../src/http/routes/daemon-control.js";

describe("daemon control routes", () => {
	it("returns health information", async () => {
		const { health } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now() - 1000,
			isTransportConnected: () => true,
			lastSyncAt: () => "2026-04-01T00:00:00.000Z",
			triggerSync: vi.fn(async () => {}),
			requestShutdown: vi.fn(() => {}),
		});

		const result = (await health({}, undefined)) as {
			status: string;
			version: string;
			uptime: number;
			transportConnected: boolean;
		};
		expect(result.status).toBe("ok");
		expect(result.version).toBe("0.2.0-beta.6");
		expect(result.transportConnected).toBe(true);
		expect(result.uptime).toBeGreaterThanOrEqual(1000);
	});

	it("triggers sync", async () => {
		const triggerSync = vi.fn(async () => {});
		const { sync } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now(),
			isTransportConnected: () => true,
			lastSyncAt: () => undefined,
			triggerSync,
			requestShutdown: vi.fn(),
		});

		const result = await sync({}, undefined);
		expect(triggerSync).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});

	it("requests shutdown", async () => {
		const requestShutdown = vi.fn();
		const { shutdown } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now(),
			isTransportConnected: () => true,
			lastSyncAt: () => undefined,
			triggerSync: vi.fn(),
			requestShutdown,
		});

		const result = await shutdown({}, undefined);
		expect(requestShutdown).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});
});
