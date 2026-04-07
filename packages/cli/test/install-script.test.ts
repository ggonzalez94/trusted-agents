import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

describe("scripts/install.sh", () => {
	let tempRoot: string;
	let binDir: string;
	let npmLogPath: string;
	let npxLogPath: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-install-script-"));
		binDir = join(tempRoot, "bin");
		currentBinDir = binDir;
		npmLogPath = join(tempRoot, "npm.log");
		npxLogPath = join(tempRoot, "npx.log");
		await mkdir(binDir, { recursive: true });
		await writeFakeNode(binDir);
		await writeFakeNpm(binDir, npmLogPath);
		await writeFakeNpx(binDir, npxLogPath);
	});

	afterEach(async () => {
		currentBinDir = "";
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("installs the stable CLI by default", async () => {
		await runInstallScript([]);

		expect(await readCommandLog(npmLogPath)).toEqual(["i -g trusted-agents-cli"]);
		expect(await readCommandLog(npxLogPath)).toEqual(["-y trusted-agents-cli install"]);
	});

	it("installs the beta channel when requested", async () => {
		await runInstallScript(["--channel", "beta"]);

		expect(await readCommandLog(npmLogPath)).toEqual(["i -g trusted-agents-cli@beta"]);
		expect(await readCommandLog(npxLogPath)).toEqual([
			"-y trusted-agents-cli@beta install --channel beta",
		]);
	});

	it("installs an exact version when requested", async () => {
		await runInstallScript(["--version", "0.2.0-beta.1"]);

		expect(await readCommandLog(npmLogPath)).toEqual(["i -g trusted-agents-cli@0.2.0-beta.1"]);
		expect(await readCommandLog(npxLogPath)).toEqual([
			"-y trusted-agents-cli@0.2.0-beta.1 install --version 0.2.0-beta.1",
		]);
	});

	it("prefers an explicit version over the channel", async () => {
		await runInstallScript(["--channel", "beta", "--version", "0.2.0-beta.1"]);

		expect(await readCommandLog(npmLogPath)).toEqual(["i -g trusted-agents-cli@0.2.0-beta.1"]);
		expect(await readCommandLog(npxLogPath)).toEqual([
			"-y trusted-agents-cli@0.2.0-beta.1 install --version 0.2.0-beta.1",
		]);
	});
});

async function runInstallScript(args: string[]): Promise<void> {
	await execFileAsync("bash", [installScriptPath, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${currentBinDir}:${process.env.PATH ?? ""}`,
		},
	});
}

let currentBinDir = "";

async function writeFakeNode(binDir: string): Promise<void> {
	const scriptPath = join(binDir, "node");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  printf 'v20.11.0\\n'
  exit 0
fi

if [[ "$1" == "-e" ]]; then
  printf '20'
  exit 0
fi

echo "unexpected node args: $*" >&2
exit 1
`,
	);
	await chmod(scriptPath, 0o755);
}

async function writeFakeNpm(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "npm");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
	);
	await chmod(scriptPath, 0o755);
}

async function writeFakeNpx(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "npx");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
	);
	await chmod(scriptPath, 0o755);
}

async function readCommandLog(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf-8").catch(() => "");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
