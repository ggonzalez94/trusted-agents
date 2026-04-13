import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeStartMock = vi.fn().mockResolvedValue(undefined);
const runtimeStopMock = vi.fn().mockResolvedValue(undefined);
const runtimeSyncOnceMock = vi.fn().mockResolvedValue({
	synced: true,
	processed: 0,
	pendingRequests: [],
});
const runtimeGetStatusMock = vi.fn().mockResolvedValue({
	running: true,
	lastSyncAt: undefined,
	lock: null,
	pendingRequests: [],
});

const createTapRuntimeMock = vi.fn().mockResolvedValue({
	start: runtimeStartMock,
	stop: runtimeStopMock,
	syncOnce: runtimeSyncOnceMock,
	getStatus: runtimeGetStatusMock,
});

const loadTrustedAgentConfigFromDataDirMock = vi.fn().mockResolvedValue({
	agentId: 42,
	chain: "eip155:8453",
	dataDir: "/tmp/tap-agent",
	ows: { wallet: "wallet-1", apiKey: "api-key-1" },
	chains: {},
	inviteExpirySeconds: 3600,
	resolveCacheTtlMs: 60_000,
	resolveCacheMaxEntries: 100,
	xmtpDbEncryptionKey: undefined,
});

vi.mock("trusted-agents-sdk", () => {
	class MockOwsSigningProvider {
		constructor(
			public readonly wallet: string,
			public readonly chain: string,
			public readonly apiKey: string,
		) {}
	}

	class MockSchedulingHandler {
		constructor(public readonly options: unknown) {}
	}

	return {
		OwsSigningProvider: MockOwsSigningProvider,
		SchedulingHandler: MockSchedulingHandler,
		createTapRuntime: (...args: unknown[]) => createTapRuntimeMock(...args),
		loadTrustedAgentConfigFromDataDir: (...args: unknown[]) =>
			loadTrustedAgentConfigFromDataDirMock(...args),
	};
});

import { HermesTapRegistry } from "../src/hermes/registry.js";

describe("HermesTapRegistry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not recreate the reconcile interval when the runtime is already running", async () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue({} as never);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

		const registry = new HermesTapRegistry(
			{
				identities: [
					{
						name: "default",
						dataDir: "/tmp/tap-agent",
						reconcileIntervalMinutes: 10,
					},
				],
			},
			{ stateDir: "/tmp/hermes-state" } as never,
			{
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		);

		await (
			registry as never as { ensureRuntimeStarted(name: string): Promise<unknown> }
		).ensureRuntimeStarted("default");
		await (
			registry as never as { ensureRuntimeStarted(name: string): Promise<unknown> }
		).ensureRuntimeStarted("default");

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).not.toHaveBeenCalled();
		expect(runtimeStartMock).toHaveBeenCalledTimes(2);
	});
});
