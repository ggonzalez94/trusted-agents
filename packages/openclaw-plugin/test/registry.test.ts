import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
						unsafeApproveActions: false,
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
						unsafeApproveActions: false,
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
});
