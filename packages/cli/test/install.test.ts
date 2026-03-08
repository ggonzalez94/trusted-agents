import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand } from "../src/commands/install.js";

describe("tap install", () => {
	let tempRoot: string;
	let homeDir: string;
	let sourceDir: string;
	let binDir: string;
	let originalHome: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-install-"));
		homeDir = join(tempRoot, "home");
		sourceDir = join(tempRoot, "src");
		binDir = join(tempRoot, "bin");
		await mkdir(homeDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await seedSourceTree(sourceDir);

		originalHome = process.env.HOME;
		originalPath = process.env.PATH;
		process.env.HOME = homeDir;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("auto-installs generic skills and the OpenClaw plugin for detected runtimes", async () => {
		await mkdir(join(homeDir, ".codex"), { recursive: true });
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ sourceDir }, { json: true });

		expect(await readSymlink(join(homeDir, ".codex", "skills", "trusted-agents"))).toBe(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
		);
		expect(await readSymlink(join(homeDir, ".openclaw", "skills", "trusted-agents"))).toBe(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
		);

		const pluginLog = await readFile(join(tempRoot, "openclaw.log"), "utf-8");
		expect(pluginLog).toContain("plugins install --link");
		expect(pluginLog).toContain(join(sourceDir, "packages", "openclaw-plugin"));
	});

	it("installs an explicitly requested generic runtime even when it was not auto-detected", async () => {
		await installCommand({ sourceDir, runtimes: ["claude"] }, { json: true });

		expect(await readSymlink(join(homeDir, ".claude", "skills", "trusted-agents"))).toBe(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
		);
	});
});

async function seedSourceTree(sourceDir: string): Promise<void> {
	await mkdir(join(sourceDir, "packages", "cli", "dist"), { recursive: true });
	await mkdir(join(sourceDir, "packages", "sdk", "skills", "trusted-agents"), {
		recursive: true,
	});
	await mkdir(join(sourceDir, "packages", "openclaw-plugin"), { recursive: true });
	await writeFile(join(sourceDir, "packages", "cli", "dist", "bin.js"), "#!/usr/bin/env node\n");
	await writeFile(
		join(sourceDir, "packages", "sdk", "skills", "trusted-agents", "SKILL.md"),
		"---\nname: trusted-agents\ndescription: test\n---\n",
	);
	await writeFile(
		join(sourceDir, "packages", "openclaw-plugin", "openclaw.plugin.json"),
		'{"id":"trusted-agents-tap"}\n',
	);
}

async function writeFakeOpenClaw(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "openclaw");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logPath}"\n`,
	);
	await chmod(scriptPath, 0o755);
}

async function readSymlink(path: string): Promise<string> {
	return await readlink(path);
}
