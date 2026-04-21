import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTapSkillsSourcePath } from "../lib/skill-source.js";
import {
	type TapHermesPaths,
	getTapHermesPaths,
	loadTapHermesPluginConfig,
	resolveHermesHome,
	saveTapHermesPluginConfig,
} from "./config.js";

/**
 * Install the Hermes plugin, hook, and skill directories under HERMES_HOME.
 *
 * After Phase 4 there is no Hermes-owned daemon state directory: tapd lives
 * in the TAP data dir, not under HERMES_HOME. The install only:
 *   1. creates the plugin / hook / skill destination directories
 *   2. copies the bundled assets into them
 *   3. ensures the Hermes TAP plugin config file exists (initialized empty
 *      if missing) so subsequent `tap hermes configure` calls have a target.
 */
export async function installTapHermesAssets(hermesHome?: string): Promise<TapHermesPaths> {
	const resolvedHome = resolveHermesHome(hermesHome);
	const paths = getTapHermesPaths(resolvedHome);
	const assets = resolveTapHermesAssetPaths();

	await mkdir(paths.pluginDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.hookDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.skillDir, { recursive: true, mode: 0o700 });

	await copyDirectoryContents(assets.pluginDir, paths.pluginDir);
	await copyDirectoryContents(assets.hookDir, paths.hookDir);
	await copyDirectoryContents(assets.skillDir, paths.skillDir);

	const config = await loadTapHermesPluginConfig(resolvedHome);
	await saveTapHermesPluginConfig(resolvedHome, config);

	return paths;
}

export function resolveTapHermesAssetPaths(): {
	pluginDir: string;
	hookDir: string;
	skillDir: string;
} {
	const packagedRoot = fileURLToPath(new URL("../../assets/hermes/", import.meta.url));

	return {
		pluginDir: join(packagedRoot, "plugin"),
		hookDir: join(packagedRoot, "hook"),
		skillDir: resolveTapSkillsSourcePath(),
	};
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true, mode: 0o700 });
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		// Do not ship in-tree unit test files to end-user installs.
		if (entry.name.startsWith("test_") && entry.name.endsWith(".py")) {
			continue;
		}
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			await copyDirectoryContents(sourcePath, targetPath);
			continue;
		}
		await mkdir(targetDir, { recursive: true, mode: 0o700 });
		await copyFile(sourcePath, targetPath);
	}
}
