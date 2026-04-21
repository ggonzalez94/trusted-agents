import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import { type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd.js";

interface FakeApiHandle {
	api: Parameters<typeof plugin.register>[0];
	startedServices: Array<{ id: string }>;
	stoppedServices: Array<{ id: string }>;
	registeredTools: Array<{ name: string }>;
	hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
	system: {
		enqueueSystemEvent: ReturnType<typeof vi.fn>;
		requestHeartbeatNow: ReturnType<typeof vi.fn>;
	};
}

function createFakeApi(pluginConfig: Record<string, unknown> = {}): FakeApiHandle {
	const startedServices: Array<{ id: string }> = [];
	const stoppedServices: Array<{ id: string }> = [];
	const registeredTools: Array<{ name: string }> = [];
	const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const system = {
		enqueueSystemEvent: vi.fn(),
		requestHeartbeatNow: vi.fn(),
	};

	const api = {
		id: "trusted-agents-tap",
		name: "Trusted Agents TAP",
		source: "test",
		config: {} as never,
		pluginConfig,
		runtime: { system } as never,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		registerService: (svc: {
			id: string;
			start?: () => Promise<void>;
			stop?: () => Promise<void>;
		}) => {
			(async () => {
				try {
					await svc.start?.();
					startedServices.push({ id: svc.id });
				} catch {
					// allow service to fail without crashing the fake host
				}
			})();
			// Track stop separately so tests can call it.
			(svc as unknown as { __stop?: () => Promise<void> }).__stop = svc.stop;
		},
		registerTool: (tool: { name: string }) => {
			registeredTools.push({ name: tool.name });
		},
		on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
			const list = hooks.get(hookName) ?? [];
			list.push(handler);
			hooks.set(hookName, list);
		},
		registerHook: vi.fn(),
		registerHttpRoute: vi.fn(),
		registerChannel: vi.fn(),
		registerGatewayMethod: vi.fn(),
		registerCli: vi.fn(),
		registerProvider: vi.fn(),
		registerCommand: vi.fn(),
		resolvePath: (p: string) => p,
	} as unknown as Parameters<typeof plugin.register>[0];

	return { api, startedServices, stoppedServices, registeredTools, hooks, system };
}

describe("plugin.register", () => {
	const handles: FakeTapdHandle[] = [];

	afterEach(async () => {
		while (handles.length > 0) {
			await handles.pop()?.stop();
		}
	});

	it("registers the tap_gateway tool", () => {
		const handle = createFakeApi({ tapdSocketPath: "/tmp/missing.sock" });
		plugin.register(handle.api);

		expect(handle.registeredTools).toEqual([{ name: "tap_gateway" }]);
	});

	it("registers a before_prompt_build hook", () => {
		const handle = createFakeApi({ tapdSocketPath: "/tmp/missing.sock" });
		plugin.register(handle.api);

		expect(handle.hooks.has("before_prompt_build")).toBe(true);
		expect(handle.hooks.get("before_prompt_build")).toHaveLength(1);
	});

	it("returns a prependContext block when notifications are queued", async () => {
		const tapd = await startFakeTapd({
			routes: [
				{
					method: "GET",
					path: "/api/notifications/drain",
					handler: () => ({
						notifications: [
							{
								id: "n1",
								type: "info",
								oneLiner: "alice said hi",
								createdAt: "2026-01-01T00:00:00Z",
							},
						],
					}),
				},
				{ method: "GET", path: "/daemon/health", handler: () => ({ status: "ok" }) },
			],
		});
		handles.push(tapd);

		const handle = createFakeApi({ tapdSocketPath: tapd.socketPath });
		plugin.register(handle.api);

		const hook = handle.hooks.get("before_prompt_build")?.[0];
		expect(hook).toBeDefined();

		const result = await (hook as (event: unknown, ctx: unknown) => Promise<unknown>)(
			{ prompt: "", messages: [] },
			{},
		);

		expect(result).toEqual({
			prependContext: ["[TAP Notifications]", "- INFO: alice said hi"].join("\n"),
		});
	});

	it("returns undefined when the drain is empty", async () => {
		const tapd = await startFakeTapd({
			routes: [
				{
					method: "GET",
					path: "/api/notifications/drain",
					handler: () => ({ notifications: [] }),
				},
			],
		});
		handles.push(tapd);

		const handle = createFakeApi({ tapdSocketPath: tapd.socketPath });
		plugin.register(handle.api);

		const hook = handle.hooks.get("before_prompt_build")?.[0];
		const result = await (hook as (event: unknown, ctx: unknown) => Promise<unknown>)(
			{ prompt: "", messages: [] },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("warns and returns undefined if the drain throws", async () => {
		const handle = createFakeApi({ tapdSocketPath: "/tmp/definitely-missing.sock" });
		plugin.register(handle.api);

		const hook = handle.hooks.get("before_prompt_build")?.[0];
		const result = await (hook as (event: unknown, ctx: unknown) => Promise<unknown>)(
			{ prompt: "", messages: [] },
			{},
		);

		expect(result).toBeUndefined();
		expect(handle.api.logger.warn).toHaveBeenCalled();
	});
});
