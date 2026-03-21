import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TapEmitEventPayload } from "../src/event-classifier.js";
import { TapNotificationQueue } from "../src/notification-queue.js";
import { OpenClawTapRegistry } from "../src/registry.js";

function createLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

describe("OpenClawTapRegistry", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	it("returns actionable warnings when no identities are configured", async () => {
		const logger = createLogger();
		const registry = new OpenClawTapRegistry({ identities: [] }, logger);

		const status = await registry.status();

		expect(status.configured).toBe(false);
		expect(status.configuredIdentities).toEqual([]);
		expect(status.identities).toEqual([]);
		expect(status.warnings).toContain(
			"No TAP identities are configured. Set plugins.entries.trusted-agents-tap.config.identities and restart Gateway.",
		);
	});

	it("warns on startup when the plugin is installed without identities", async () => {
		const logger = createLogger();
		const registry = new OpenClawTapRegistry({ identities: [] }, logger);

		await registry.start();

		expect(logger.warn).toHaveBeenCalledWith(
			"[trusted-agents-tap] No TAP identities are configured. Set plugins.entries.trusted-agents-tap.config.identities and restart Gateway.",
		);
	});

	it("fails startup when a configured identity cannot start", async () => {
		const logger = createLogger();
		const registry = new OpenClawTapRegistry(
			{
				identities: [
					{
						name: "alpha",
						dataDir: "/tmp/alpha",
						reconcileIntervalMinutes: 10,
					},
				],
			},
			logger,
		);

		vi.spyOn(registry as never, "ensureRuntime").mockResolvedValue({} as never);
		vi.spyOn(registry as never, "startRuntime").mockRejectedValue(new Error("boom"));

		await expect(registry.start()).rejects.toThrow("Failed to start TAP runtimes: alpha: boom");
		expect(logger.warn).toHaveBeenCalledWith(
			"[trusted-agents-tap:alpha] Failed to start TAP runtime: boom",
		);
	});

	it("serializes invite creation through the runtime mutex", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "openclaw-registry-test-"));
		createdDirs.push(dataDir);
		const logger = createLogger();
		const registry = new OpenClawTapRegistry(
			{
				identities: [
					{
						name: "alpha",
						dataDir,
						reconcileIntervalMinutes: 10,
					},
				],
			},
			logger,
		);

		const runExclusive = vi.fn(async (work: () => Promise<unknown>) => await work());
		vi.spyOn(registry as never, "ensureRuntimeForAction").mockResolvedValue({
			definition: { name: "alpha" },
			config: {
				agentId: 7,
				chain: "eip155:84532",
				privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
				inviteExpirySeconds: 600,
				dataDir,
			},
			mutex: { runExclusive },
		} as never);

		const result = await registry.createInvite("alpha");

		expect(result.identity).toBe("alpha");
		expect(runExclusive).toHaveBeenCalledTimes(1);
		expect(result.url).toContain("trustedagents.link/connect");
		expect(result.expiresInSeconds).toBe(600);
	});

	it("routes TAP escalations through the injected OpenClaw runtime system", () => {
		const logger = createLogger();
		const enqueueSystemEvent = vi.fn();
		const requestHeartbeatNow = vi.fn();
		const registry = new OpenClawTapRegistry({ identities: [] }, logger, {
			sessionKey: "agent:alpha:primary",
			system: {
				enqueueSystemEvent,
				requestHeartbeatNow,
			},
		});

		(registry as never).triggerEscalation("Connection request from agent #7 requires attention");

		expect(enqueueSystemEvent).toHaveBeenCalledWith(
			"TAP: Connection request from agent #7 requires attention",
			{
				sessionKey: "agent:alpha:primary",
				contextKey: "tap:escalation",
			},
		);
		expect(requestHeartbeatNow).toHaveBeenCalledWith({
			reason: "hook:tap-escalation",
			coalesceMs: 2000,
			sessionKey: "agent:alpha:primary",
		});
	});

	describe("handleEmitEvent triggers escalation for all classified events", () => {
		function makeEvent(overrides: Partial<TapEmitEventPayload> = {}): TapEmitEventPayload {
			return {
				direction: "incoming",
				from: 42,
				fromName: "TestPeer",
				method: "message/send",
				id: "msg-1",
				receipt_status: "delivered",
				timestamp: "2026-03-21T00:00:00.000Z",
				...overrides,
			};
		}

		function createRegistryWithEscalation() {
			const logger = createLogger();
			const enqueueSystemEvent = vi.fn();
			const requestHeartbeatNow = vi.fn();
			const registry = new OpenClawTapRegistry({ identities: [] }, logger, {
				sessionKey: "agent:test:primary",
				system: { enqueueSystemEvent, requestHeartbeatNow },
			});
			return { registry, enqueueSystemEvent, requestHeartbeatNow };
		}

		it("triggers escalation for message/send (auto-handle bucket)", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "message/send" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
			expect(queue.peek()).toHaveLength(1);
			expect(queue.peek()[0]!.type).toBe("summary");
		});

		it("triggers escalation for permissions/update (auto-handle bucket)", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "permissions/update" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
			expect(queue.peek()[0]!.type).toBe("summary");
		});

		it("triggers escalation for action/result (auto-handle bucket)", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "action/result" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
			expect(queue.peek()[0]!.type).toBe("summary");
		});

		it("triggers escalation for connection/result (notify bucket)", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "connection/result" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
			expect(queue.peek()[0]!.type).toBe("info");
		});

		it("triggers escalation for connection/request (escalate bucket)", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "connection/request" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
			expect(queue.peek()[0]!.type).toBe("escalation");
		});

		it("does not trigger escalation for duplicate notifications", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "message/send", id: "dup-1" }));
			(registry as never).handleEmitEvent("test", queue, makeEvent({ method: "message/send", id: "dup-1" }));

			expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
		});

		it("does not trigger escalation for null-classified events", () => {
			const { registry, requestHeartbeatNow } = createRegistryWithEscalation();
			const queue = new TapNotificationQueue();

			(registry as never).handleEmitEvent("test", queue, makeEvent({ direction: "outgoing" }));

			expect(requestHeartbeatNow).not.toHaveBeenCalled();
			expect(queue.peek()).toHaveLength(0);
		});
	});

	it("logs escalation wake failures instead of swallowing them", () => {
		const logger = createLogger();
		const enqueueSystemEvent = vi.fn(() => {
			throw new Error("boom");
		});
		const requestHeartbeatNow = vi.fn();
		const registry = new OpenClawTapRegistry({ identities: [] }, logger, {
			sessionKey: "agent:main:main",
			system: {
				enqueueSystemEvent,
				requestHeartbeatNow,
			},
		});

		(registry as never).triggerEscalation("Transfer request requires approval");

		expect(logger.warn).toHaveBeenCalledWith(
			"[trusted-agents-tap] Failed to trigger OpenClaw heartbeat wake: boom",
		);
		expect(requestHeartbeatNow).not.toHaveBeenCalled();
	});
});
