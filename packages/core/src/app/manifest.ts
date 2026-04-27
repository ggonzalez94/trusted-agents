import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../common/atomic-json.js";
import { AsyncMutex } from "../common/index.js";

// Per-dataDir mutex to protect read-modify-write sequences in manifest operations
const manifestMutexes = new Map<string, AsyncMutex>();
function getManifestMutex(dataDir: string): AsyncMutex {
	let mutex = manifestMutexes.get(dataDir);
	if (!mutex) {
		mutex = new AsyncMutex();
		manifestMutexes.set(dataDir, mutex);
	}
	return mutex;
}

export interface AppManifestEntry {
	package: string;
	entryPoint: string;
	installedAt: string;
	status: "active" | "inactive";
}

export interface AppManifest {
	apps: Record<string, AppManifestEntry>;
}

export interface RoutingEntry {
	appId: string;
	entryPoint: string;
}

function manifestPath(dataDir: string): string {
	return join(dataDir, "apps.json");
}

export async function loadAppManifest(dataDir: string): Promise<AppManifest> {
	try {
		const content = await readFile(manifestPath(dataDir), "utf-8");
		return JSON.parse(content) as AppManifest;
	} catch {
		return { apps: {} };
	}
}

export async function saveAppManifest(dataDir: string, manifest: AppManifest): Promise<void> {
	await writeJsonFileAtomic(manifestPath(dataDir), manifest, { tempPrefix: ".apps" });
}

export async function addAppToManifest(
	dataDir: string,
	appId: string,
	entry: AppManifestEntry,
): Promise<void> {
	const mutex = getManifestMutex(dataDir);
	await mutex.runExclusive(async () => {
		const manifest = await loadAppManifest(dataDir);
		manifest.apps[appId] = entry;
		await saveAppManifest(dataDir, manifest);
	});
}

export async function removeAppFromManifest(dataDir: string, appId: string): Promise<void> {
	const mutex = getManifestMutex(dataDir);
	await mutex.runExclusive(async () => {
		const manifest = await loadAppManifest(dataDir);
		delete manifest.apps[appId];
		await saveAppManifest(dataDir, manifest);
	});
}

export function buildRoutingTable(manifest: AppManifest): Map<string, RoutingEntry> {
	const table = new Map<string, RoutingEntry>();
	for (const [appId, entry] of Object.entries(manifest.apps)) {
		if (entry.status !== "active") continue;
		table.set(appId, { appId, entryPoint: entry.entryPoint });
	}
	return table;
}
