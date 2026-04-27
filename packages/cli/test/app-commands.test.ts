import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appListCommand, appRemoveCommand } from "../src/commands/app.js";
import { defaultConfigPath } from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { UNREGISTERED_AGENT_CONFIG_YAML } from "./helpers/config-fixtures.js";

describe("tap app commands", () => {
	let tempRoot: string;
	let dataDir: string;
	let logWrites: string[];
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	const appsManifestPath = () => join(dataDir, "apps.json");
	const writeManifest = async (manifest: unknown) => {
		await writeFile(appsManifestPath(), JSON.stringify(manifest));
	};
	const readManifest = async () =>
		JSON.parse(await readFile(appsManifestPath(), "utf-8")) as {
			apps: Record<string, unknown>;
		};

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-app-cmd-"));
		dataDir = join(tempRoot, "data");
		await mkdir(dataDir, { recursive: true });
		await writeFile(defaultConfigPath(dataDir), UNREGISTERED_AGENT_CONFIG_YAML, "utf-8");
		logWrites = [];
		// The app commands use console.log for success output
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logWrites.push(args.map(String).join(" "));
		});
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
		await rm(tempRoot, { recursive: true, force: true });
	});

	describe("app remove", () => {
		it.each([
			["by app ID", "betting", "betting"],
			["by package name", "betting", "tap-app-betting"],
			["by short name fallback", "mybet", "betting"],
		])("removes app %s", async (_, appKey, lookupId) => {
			await writeManifest({
				apps: {
					[appKey]: {
						package: "tap-app-betting",
						entryPoint: "tap-app-betting",
						installedAt: "2026-03-30T00:00:00.000Z",
						status: "active",
					},
				},
			});

			await appRemoveCommand(lookupId, { dataDir });

			const manifest = await readManifest();
			expect(manifest.apps[appKey]).toBeUndefined();
			const allOutput = logWrites.join("\n");
			expect(allOutput).toContain("Removed");
			expect(allOutput).toContain(appKey);
		});

		it("errors when no matching app is found", async () => {
			await writeManifest({ apps: {} });

			await appRemoveCommand("nonexistent", { dataDir });

			expect(process.exitCode).toBe(1);
			const allOutput = [...logWrites, ...stdoutWrites, ...stderrWrites].join("\n");
			expect(allOutput).toContain("No installed app matches");
			expect(allOutput).toContain("nonexistent");
			const manifest = await readManifest();
			expect(Object.keys(manifest.apps)).toHaveLength(0);
		});

		it("errors when manifest has apps but none match the given name", async () => {
			await writeManifest({
				apps: {
					transfer: {
						package: "@trustedagents/app-transfer",
						entryPoint: "@trustedagents/app-transfer",
						installedAt: "2026-03-30T00:00:00.000Z",
						status: "active",
					},
				},
			});

			await appRemoveCommand("betting", { dataDir });

			expect(process.exitCode).toBe(1);
			const allOutput = [...logWrites, ...stdoutWrites, ...stderrWrites].join("\n");
			expect(allOutput).toContain("No installed app matches");
			// The existing app should remain untouched
			const manifest = await readManifest();
			expect(manifest.apps.transfer).toBeDefined();
		});
	});

	describe("app list", () => {
		it("shows installed apps", async () => {
			await writeManifest({
				apps: {
					transfer: {
						package: "@trustedagents/app-transfer",
						entryPoint: "@trustedagents/app-transfer",
						installedAt: "2026-03-30T00:00:00.000Z",
						status: "active",
					},
				},
			});

			await appListCommand({ dataDir });

			const allOutput = logWrites.join("\n");
			expect(allOutput).toContain("transfer");
			expect(allOutput).toContain("@trustedagents/app-transfer");
		});

		it("shows 'no apps' when manifest is empty", async () => {
			await writeManifest({ apps: {} });

			await appListCommand({ dataDir });

			const allOutput = logWrites.join("\n");
			expect(allOutput).toContain("No apps installed");
		});

		it("shows status suffix for inactive apps", async () => {
			await writeManifest({
				apps: {
					betting: {
						package: "tap-app-betting",
						entryPoint: "tap-app-betting",
						installedAt: "2026-03-30T00:00:00.000Z",
						status: "inactive",
					},
				},
			});

			await appListCommand({ dataDir });

			const allOutput = logWrites.join("\n");
			expect(allOutput).toContain("betting");
			expect(allOutput).toContain("[inactive]");
		});

		it("works when no manifest file exists yet", async () => {
			await appListCommand({ dataDir });

			const allOutput = logWrites.join("\n");
			expect(allOutput).toContain("No apps installed");
		});
	});
});
