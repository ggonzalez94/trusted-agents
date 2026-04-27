import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCalendarProvider,
	readCalendarProvider,
	writeCalendarConfig,
} from "../../src/lib/calendar/setup.js";

describe("createCalendarProvider", () => {
	it("throws for unknown providers", () => {
		expect(() => createCalendarProvider("not-supported")).toThrow(
			"Unknown calendar provider: not-supported",
		);
	});

	it("writes calendar provider without replacing existing config", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "tap-calendar-"));
		try {
			const configPath = join(dataDir, "config.yaml");
			await writeFile(configPath, "agent_id: 42\nchain: eip155:8453\n", "utf-8");

			await writeCalendarConfig(dataDir, "google");

			expect(readCalendarProvider(dataDir)).toBe("google");
			const updated = await readFile(configPath, "utf-8");
			expect(updated).toContain("agent_id: 42");
			expect(updated).toContain("chain: eip155:8453");
			expect(updated).toContain("provider: google");
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no calendar provider is configured", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "tap-calendar-"));
		try {
			expect(readCalendarProvider(dataDir)).toBeUndefined();
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
