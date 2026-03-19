import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = JSON.stringify({ valid: true });
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = "";
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("auto-installs generic skills for generic runtimes and the OpenClaw plugin for OpenClaw", async () => {
		await mkdir(join(homeDir, ".codex"), { recursive: true });
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ sourceDir }, { json: true });

		expect(await readSymlink(join(homeDir, ".codex", "skills", "trusted-agents"))).toBe(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
		);
		await expect(pathMissing(join(homeDir, ".openclaw", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);

		const pluginLog = await readFile(join(tempRoot, "openclaw.log"), "utf-8");
		expect(pluginLog).toContain("plugins install --link");
		expect(pluginLog).toContain("config validate --json");
		expect(pluginLog).toContain(join(sourceDir, "packages", "openclaw-plugin"));
	});

	it("installs the OpenClaw plugin without linking generic skills into ~/.openclaw", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		await expect(pathMissing(join(homeDir, ".openclaw", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			`plugins install --link ${join(sourceDir, "packages", "openclaw-plugin")}`,
			"config validate --json",
		]);
	});

	it("removes a legacy TAP-managed ~/.openclaw skill symlink before plugin install", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		await mkdir(join(homeDir, ".openclaw", "skills"), { recursive: true });
		await symlink(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
			join(homeDir, ".openclaw", "skills", "trusted-agents"),
		);

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		await expect(pathMissing(join(homeDir, ".openclaw", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);
		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			`plugins install --link ${join(sourceDir, "packages", "openclaw-plugin")}`,
			"config validate --json",
		]);
	});

	it("installs an explicitly requested generic runtime even when it was not auto-detected", async () => {
		await installCommand({ sourceDir, runtimes: ["claude"] }, { json: true });

		expect(await readSymlink(join(homeDir, ".claude", "skills", "trusted-agents"))).toBe(
			join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
		);
	});

	it("does not check or manipulate gateway state during plugin install", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		const log = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(log).not.toContain(expect.stringContaining("gateway"));
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
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"

if [[ "$1" == "config" && "$2" == "validate" ]]; then
  validate_json="$FAKE_OPENCLAW_CONFIG_VALIDATE_JSON"
  if [[ -z "$validate_json" ]]; then
    validate_json='{"valid":true}'
  fi
  printf '%s\\n' "$validate_json"
  exit 0
fi

if [[ "$1" == "plugins" && "$2" == "install" ]]; then
  exit "\${FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE:-0}"
fi
`,
	);
	await chmod(scriptPath, 0o755);
}

async function readSymlink(path: string): Promise<string> {
	return await readlink(path);
}

async function pathMissing(path: string): Promise<boolean> {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

async function readCommandLog(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
