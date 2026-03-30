import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
	const filePath = manifestPath(dataDir);
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmpPath = join(dir, `.apps-${randomUUID()}.tmp`);
	await writeFile(tmpPath, JSON.stringify(manifest, null, "\t"), { mode: 0o600 });
	await rename(tmpPath, filePath);
}

export async function addAppToManifest(
	dataDir: string,
	appId: string,
	entry: AppManifestEntry,
): Promise<void> {
	const manifest = await loadAppManifest(dataDir);
	manifest.apps[appId] = entry;
	await saveAppManifest(dataDir, manifest);
}

export async function removeAppFromManifest(dataDir: string, appId: string): Promise<void> {
	const manifest = await loadAppManifest(dataDir);
	delete manifest.apps[appId];
	await saveAppManifest(dataDir, manifest);
}

export function buildRoutingTable(manifest: AppManifest): Map<string, RoutingEntry> {
	const table = new Map<string, RoutingEntry>();
	for (const [appId, entry] of Object.entries(manifest.apps)) {
		if (entry.status !== "active") continue;
		table.set(appId, { appId, entryPoint: entry.entryPoint });
	}
	return table;
}
