import { describe, expect, it } from "vitest";
import {
	type AppManifest,
	type AppManifestEntry,
	addAppToManifest,
	appManifestPath,
	buildRoutingTable,
	loadAppManifest,
	removeAppFromManifest,
	saveAppManifest,
} from "../../../src/app/manifest.js";
import { useTempDir } from "../../helpers/temp-dir.js";

describe("AppManifest", () => {
	const dir = useTempDir("tap-manifest");

	it("derives the app manifest path from the data dir", () => {
		expect(appManifestPath("/tmp/tap-data")).toBe("/tmp/tap-data/apps.json");
	});

	it("returns empty manifest when file does not exist", async () => {
		const manifest = await loadAppManifest(dir.path);
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
		await saveAppManifest(dir.path, manifest);
		const loaded = await loadAppManifest(dir.path);
		expect(loaded).toEqual(manifest);
	});

	it("adds an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(dir.path, "betting", entry);
		const manifest = await loadAppManifest(dir.path);
		expect(manifest.apps.betting).toEqual(entry);
	});

	it("removes an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(dir.path, "betting", entry);
		await removeAppFromManifest(dir.path, "betting");
		const manifest = await loadAppManifest(dir.path);
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
