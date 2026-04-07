import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AppManifest,
	type AppManifestEntry,
	addAppToManifest,
	buildRoutingTable,
	loadAppManifest,
	removeAppFromManifest,
	saveAppManifest,
} from "../../../src/app/manifest.js";

describe("AppManifest", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-manifest-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns empty manifest when file does not exist", async () => {
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps).toEqual({});
	});

	it("saves and loads a manifest", async () => {
		const manifest: AppManifest = {
			apps: {
				transfer: {
					package: "@trustedagents/app-transfer",
					entryPoint: "@trustedagents/app-transfer",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "active",
				},
			},
		};
		await saveAppManifest(tmpDir, manifest);
		const loaded = await loadAppManifest(tmpDir);
		expect(loaded).toEqual(manifest);
	});

	it("adds an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(tmpDir, "betting", entry);
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps.betting).toEqual(entry);
	});

	it("removes an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(tmpDir, "betting", entry);
		await removeAppFromManifest(tmpDir, "betting");
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps.betting).toBeUndefined();
	});

	it("builds routing table from manifest", () => {
		const manifest: AppManifest = {
			apps: {
				transfer: {
					package: "@trustedagents/app-transfer",
					entryPoint: "@trustedagents/app-transfer",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "active",
				},
			},
		};
		const table = buildRoutingTable(manifest);
		expect(table.size).toBe(1);
		expect(table.get("transfer")).toEqual({
			appId: "transfer",
			entryPoint: "@trustedagents/app-transfer",
		});
	});

	it("skips inactive apps in routing table", () => {
		const manifest: AppManifest = {
			apps: {
				betting: {
					package: "tap-app-betting",
					entryPoint: "tap-app-betting",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "inactive",
				},
			},
		};
		const table = buildRoutingTable(manifest);
		expect(table.size).toBe(0);
	});
});
