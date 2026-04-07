import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_HERMES_RECONCILE_INTERVAL_MINUTES,
	getTapHermesPaths,
	loadTapHermesPluginConfig,
	parseTapHermesPluginConfig,
	upsertTapHermesIdentity,
} from "../src/hermes/config.js";

describe("Tap Hermes config", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	it("parses empty config as no identities", () => {
		expect(parseTapHermesPluginConfig(undefined)).toEqual({ identities: [] });
		expect(parseTapHermesPluginConfig(null)).toEqual({ identities: [] });
	});

	it("normalizes identity defaults and rejects duplicates", () => {
		const parsed = parseTapHermesPluginConfig({
			identities: [{ dataDir: "/tmp/alpha" }],
		});

		expect(parsed.identities).toEqual([
			{
				name: "default",
				dataDir: "/tmp/alpha",
				reconcileIntervalMinutes: DEFAULT_HERMES_RECONCILE_INTERVAL_MINUTES,
			},
		]);

		expect(() =>
			parseTapHermesPluginConfig({
				identities: [
					{ name: "alpha", dataDir: "/tmp/alpha" },
					{ name: "alpha", dataDir: "/tmp/beta" },
				],
			}),
		).toThrow("Duplicate TAP Hermes identity name");

		expect(() =>
			parseTapHermesPluginConfig({
				identities: [
					{ name: "alpha", dataDir: "/tmp/alpha" },
					{ name: "beta", dataDir: "/tmp/alpha" },
				],
			}),
		).toThrow("Duplicate TAP Hermes identity dataDir");
	});

	it("writes and updates Hermes TAP identities on disk", async () => {
		const hermesHome = await mkdtemp(join(tmpdir(), "tap-hermes-config-"));
		createdDirs.push(hermesHome);

		const created = await upsertTapHermesIdentity({
			hermesHome,
			name: "alpha",
			dataDir: "/tmp/agent-a",
		});
		expect(created.name).toBe("alpha");

		const updated = await upsertTapHermesIdentity({
			hermesHome,
			name: "alpha",
			dataDir: "/tmp/agent-a-renamed",
			reconcileIntervalMinutes: 30,
		});
		expect(updated).toEqual({
			name: "alpha",
			dataDir: "/tmp/agent-a-renamed",
			reconcileIntervalMinutes: 30,
		});

		const config = await loadTapHermesPluginConfig(hermesHome);
		expect(config.identities).toEqual([updated]);

		const raw = JSON.parse(
			await readFile(getTapHermesPaths(hermesHome).configPath, "utf-8"),
		) as { identities: Array<{ name: string; dataDir: string; reconcileIntervalMinutes: number }> };
		expect(raw.identities).toHaveLength(1);
		expect(raw.identities[0]?.dataDir).toBe("/tmp/agent-a-renamed");
	});

	it("builds stable Hermes TAP filesystem paths", () => {
		const hermesHome = "/tmp/hermes-home";
		const paths = getTapHermesPaths(hermesHome);

		expect(paths.hermesHome).toBe(resolve(hermesHome));
		expect(paths.pluginDir).toBe(join(resolve(hermesHome), "plugins", "trusted-agents-tap"));
		expect(paths.hookDir).toBe(join(resolve(hermesHome), "hooks", "trusted-agents-tap"));
		expect(paths.skillDir).toBe(join(resolve(hermesHome), "skills", "trusted-agents"));
		expect(paths.configPath).toBe(join(paths.pluginDir, "config.json"));
		expect(paths.stateDir).toBe(join(paths.pluginDir, "state"));
		expect(paths.socketPath).toContain("tap-hermes.sock");
		expect(paths.daemonStatePath).toBe(join(paths.stateDir, "daemon.json"));
	});
});
