import { describe, expect, it, vi } from "vitest";
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
});
