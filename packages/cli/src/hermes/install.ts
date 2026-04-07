import { copyFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
	getTapHermesPaths,
	loadTapHermesPluginConfig,
	resolveHermesHome,
	saveTapHermesPluginConfig,
	type TapHermesPaths,
} from "./config.js";

export async function installTapHermesAssets(hermesHome?: string): Promise<TapHermesPaths> {
	const resolvedHome = resolveHermesHome(hermesHome);
	const paths = getTapHermesPaths(resolvedHome);
	const assets = resolveTapHermesAssetPaths();

	await mkdir(paths.pluginDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.hookDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.skillDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });

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
	const packagedSkillDir = fileURLToPath(new URL("../../assets/skills/trusted-agents/", import.meta.url));
	const repoSkillDir = fileURLToPath(new URL("../../../../skills/trusted-agents/", import.meta.url));

	return {
		pluginDir: join(packagedRoot, "plugin"),
		hookDir: join(packagedRoot, "hook"),
		skillDir: existsSync(repoSkillDir) ? repoSkillDir : packagedSkillDir,
	};
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true, mode: 0o700 });
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
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
