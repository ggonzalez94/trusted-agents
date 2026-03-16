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
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = idleGatewayStatusJson();
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = JSON.stringify({ valid: true });
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STOP_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_START_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_INSTALL_EXIT_CODE = "";
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = "";
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = "";
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STOP_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_START_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_INSTALL_EXIT_CODE = "";
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
		expect(pluginLog).toContain("gateway status --json --no-probe");
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
			"gateway status --json --no-probe",
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
			"gateway status --json --no-probe",
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

	it("stops and restarts a non-LaunchAgent OpenClaw gateway service when it is already loaded", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = runningServiceGatewayStatusJson("Systemd");

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json --no-probe",
			"gateway stop",
			`plugins install --link ${join(sourceDir, "packages", "openclaw-plugin")}`,
			"config validate --json",
			"gateway start",
		]);
	});

	it("reinstalls the LaunchAgent instead of using gateway start after a managed macOS install", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = runningServiceGatewayStatusJson("LaunchAgent");

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json --no-probe",
			"gateway stop",
			`plugins install --link ${join(sourceDir, "packages", "openclaw-plugin")}`,
			"config validate --json",
			"gateway install --force",
		]);
	});

	it("refuses to install while an unmanaged OpenClaw gateway process is already running", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = runningForegroundGatewayStatusJson();

		const stdout = await captureStdout(async () => {
			await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });
		});

		expect(process.exitCode).toBe(1);
		expect(stdout).toContain("already running outside the managed service");
		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json --no-probe",
		]);
	});

	it("does not refuse install when a non-OpenClaw process owns the configured port", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = busyNonOpenClawPortStatusJson();

		await installCommand({ sourceDir, runtimes: ["openclaw"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json --no-probe",
			`plugins install --link ${join(sourceDir, "packages", "openclaw-plugin")}`,
			"config validate --json",
		]);
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

if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  status_json="$FAKE_OPENCLAW_GATEWAY_STATUS_JSON"
  if [[ -z "$status_json" ]]; then
    status_json='${idleGatewayStatusJson()}'
  fi
  printf '%s\\n' "$status_json"
  exit 0
fi

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

if [[ "$1" == "gateway" && "$2" == "stop" ]]; then
  exit "\${FAKE_OPENCLAW_GATEWAY_STOP_EXIT_CODE:-0}"
fi

if [[ "$1" == "gateway" && "$2" == "start" ]]; then
  exit "\${FAKE_OPENCLAW_GATEWAY_START_EXIT_CODE:-0}"
fi

if [[ "$1" == "gateway" && "$2" == "install" ]]; then
  exit "\${FAKE_OPENCLAW_GATEWAY_INSTALL_EXIT_CODE:-0}"
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

async function captureStdout(run: () => Promise<void>): Promise<string> {
	let output = "";
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		return true;
	}) as typeof process.stdout.write;
	try {
		await run();
		return output;
	} finally {
		process.stdout.write = originalWrite;
	}
}

function idleGatewayStatusJson(): string {
	return JSON.stringify({
		service: { loaded: false },
		port: { status: "free", listeners: [] },
	});
}

function runningServiceGatewayStatusJson(label: string): string {
	return JSON.stringify({
		service: { loaded: true, label },
		port: {
			status: "busy",
			listeners: [{ pid: 4242, command: "node", commandLine: "openclaw-gateway" }],
		},
	});
}

function runningForegroundGatewayStatusJson(): string {
	return JSON.stringify({
		service: { loaded: false },
		port: {
			status: "busy",
			listeners: [{ pid: 7777, command: "node", commandLine: "openclaw-gateway" }],
		},
	});
}

function busyNonOpenClawPortStatusJson(): string {
	return JSON.stringify({
		service: { loaded: false },
		port: {
			status: "busy",
			listeners: [{ pid: 9898, command: "python", commandLine: "python -m http.server 18789" }],
		},
	});
}
