import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand } from "../src/commands/install.js";
import { defaultConfigPath } from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";

describe("tap install", () => {
	let tempRoot: string;
	let homeDir: string;
	let binDir: string;
	let skillsSourceDir: string;
	const { stdout: stdoutWrites } = useCapturedOutput();
	let originalHome: string | undefined;
	let originalPath: string | undefined;
	let originalSkillsSource: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-install-"));
		homeDir = join(tempRoot, "home");
		binDir = join(tempRoot, "bin");
		skillsSourceDir = join(tempRoot, "skills", "trusted-agents");
		await mkdir(homeDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(skillsSourceDir, { recursive: true });
		await writeFile(
			join(skillsSourceDir, "SKILL.md"),
			"---\nname: trusted-agents\n---\n\n# Trusted Agents Protocol\n",
			"utf-8",
		);

		originalHome = process.env.HOME;
		originalPath = process.env.PATH;
		originalSkillsSource = process.env.TAP_SKILLS_SOURCE;
		process.env.HOME = homeDir;
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		process.env.TAP_SKILLS_SOURCE = skillsSourceDir;
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = JSON.stringify({ valid: true });
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = gatewayStatusJson({
			serviceLoaded: false,
			runtimeStatus: "stopped",
			rpcOk: false,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = "20";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS = "1";
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		process.env.TAP_SKILLS_SOURCE = originalSkillsSource;
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = "";
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS = "";
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("auto-detects Claude and OpenClaw runtimes, installs packaged skills, and force-updates the plugin", async () => {
		await mkdir(join(homeDir, ".claude"), { recursive: true });
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({}, { json: true });

		const npxLog = await readCommandLog(join(tempRoot, "npx.log"));
		expect(npxLog).toEqual([`-y skills add -g ${skillsSourceDir} -y`]);

		const openclawLog = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(openclawLog).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap",
			"config validate --json",
		]);
	});

	it("installs OpenClaw plugin from npm when explicitly requested", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"] }, { json: true });

		const openclawLog = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(openclawLog).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap",
			"config validate --json",
		]);
	});

	it("installs the beta OpenClaw plugin when a channel is provided", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"], channel: "beta" }, { json: true });

		const openclawLog = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(openclawLog).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap@beta",
			"config validate --json",
		]);
	});

	it("installs an exact-version OpenClaw plugin when a version is provided", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"], version: "0.2.0-beta.1" }, { json: true });

		const openclawLog = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(openclawLog).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap@0.2.0-beta.1",
			"config validate --json",
		]);
	});

	it("prefers an explicit version over the channel when installing the OpenClaw plugin", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand(
			{ runtimes: ["openclaw"], channel: "beta", version: "0.2.0-beta.1" },
			{ json: true },
		);

		const openclawLog = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(openclawLog).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap@0.2.0-beta.1",
			"config validate --json",
		]);
	});

	it("installs Claude skills via npx skills add when explicitly requested", async () => {
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));

		await installCommand({ runtimes: ["claude"] }, { json: true });

		const npxLog = await readCommandLog(join(tempRoot, "npx.log"));
		expect(npxLog).toEqual([`-y skills add -g ${skillsSourceDir} -y`]);
	});

	it("installs Hermes plugin, startup hook, and skill assets", async () => {
		await installCommand({ runtimes: ["hermes"] }, { json: true });

		const hermesHome = join(homeDir, ".hermes");
		await expect(
			readFile(join(hermesHome, "plugins", "trusted-agents-tap", "plugin.yaml"), "utf-8"),
		).resolves.toContain("trusted-agents-tap");
		await expect(
			readFile(join(hermesHome, "plugins", "trusted-agents-tap", "config.json"), "utf-8"),
		).resolves.toContain('"identities": []');
		await expect(
			readFile(join(hermesHome, "hooks", "trusted-agents-tap", "HOOK.yaml"), "utf-8"),
		).resolves.toContain("gateway:startup");
		await expect(
			readFile(join(hermesHome, "skills", "trusted-agents", "SKILL.md"), "utf-8"),
		).resolves.toContain("# Trusted Agents Protocol");
	});

	it("uses the explicit TAP_SKILLS_SOURCE for both global skills and Hermes skill assets", async () => {
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));
		await writeFile(
			join(skillsSourceDir, "SKILL.md"),
			"---\nname: trusted-agents\ndescription: Custom TAP skill\n---\n\n# Custom TAP Skill\n",
			"utf-8",
		);

		await installCommand({ runtimes: ["claude", "hermes"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "npx.log"))).toEqual([
			`-y skills add -g ${skillsSourceDir} -y`,
		]);
		await expect(
			readFile(join(homeDir, ".hermes", "skills", "trusted-agents", "SKILL.md"), "utf-8"),
		).resolves.toContain("# Custom TAP Skill");
	});

	it("installs global skills even when no host runtime directories are detected", async () => {
		// Isolate PATH so real CLIs (like openclaw) aren't found,
		// but keep /usr/bin:/bin so env/bash resolve for shell scripts
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));
		await installCommand({}, { json: true });
		expect(await readCommandLog(join(tempRoot, "npx.log"))).toEqual([
			`-y skills add -g ${skillsSourceDir} -y`,
		]);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: {
				installed?: boolean;
				runtimes?: Array<{ runtime: string }>;
			};
		};
		expect(output.status).toBe("ok");
		expect(output.data?.installed).toBe(true);
		expect(output.data?.runtimes).toEqual(
			expect.arrayContaining([expect.objectContaining({ runtime: "skills" })]),
		);
	});

	it("reports error when npx skills add fails", async () => {
		await writeFakeNpxFailing(binDir);

		await installCommand({ runtimes: ["claude"] }, { json: true });

		expect(process.exitCode).toBeGreaterThan(0);
	});

	it("waits for OpenClaw Gateway reload after plugin install", async () => {
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 101,
			rpcOk: true,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 101,
			rpcOk: true,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 202,
			rpcOk: true,
		});
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap",
			"config validate --json",
			"gateway status --json",
			"gateway status --json",
		]);
	});

	it("re-runs the OpenClaw plugin install with overwrite semantics on repeated installs", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"] }, { json: true });
		await installCommand({ runtimes: ["openclaw"] }, { json: true });

		expect(await readCommandLog(join(tempRoot, "openclaw.log"))).toEqual([
			"gateway status --json",
			"plugins install --force trusted-agents-tap",
			"config validate --json",
			"gateway status --json",
			"plugins install --force trusted-agents-tap",
			"config validate --json",
		]);
	});

	it("warns when the selected TAP data dir contains a legacy raw-key agent that needs migration", async () => {
		// Isolate PATH so only fake CLIs are found (not real openclaw),
		// but keep /usr/bin:/bin so env/bash resolve for shell scripts
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		await mkdir(join(homeDir, ".claude"), { recursive: true });
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));
		await mkdir(join(homeDir, ".trustedagents", "identity"), { recursive: true });
		await writeFile(
			defaultConfigPath(join(homeDir, ".trustedagents")),
			"agent_id: 11\nchain: eip155:8453\n",
			"utf-8",
		);
		await writeFile(
			join(homeDir, ".trustedagents", "identity", "agent.key"),
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"utf-8",
		);

		await installCommand({}, { json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { warnings?: string[] };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.warnings).toEqual([expect.stringContaining("tap migrate-wallet")]);
	});
});

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

async function writeFakeNpxFailing(binDir: string): Promise<void> {
	const scriptPath = join(binDir, "npx");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
echo "fake npx failure" >&2
exit 1
`,
	);
	await chmod(scriptPath, 0o755);
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

if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  status_count="$(grep -c '^gateway status --json$' "${logPath}" || true)"
  status_json_var="FAKE_OPENCLAW_GATEWAY_STATUS_JSON_\${status_count}"
  status_json="\${!status_json_var:-$FAKE_OPENCLAW_GATEWAY_STATUS_JSON}"
  if [[ -z "$status_json" ]]; then
    status_json='{"service":{"loaded":false},"rpc":{"ok":false}}'
  fi
  printf '%s\\n' "$status_json"
  exit 0
fi
`,
	);
	await chmod(scriptPath, 0o755);
}

function gatewayStatusJson(params: {
	serviceLoaded: boolean;
	runtimeStatus: string;
	runtimePid?: number;
	rpcOk: boolean;
}): string {
	return JSON.stringify({
		service: {
			loaded: params.serviceLoaded,
			runtime:
				params.runtimePid === undefined
					? { status: params.runtimeStatus }
					: { status: params.runtimeStatus, pid: params.runtimePid },
		},
		rpc: { ok: params.rpcOk },
	});
}

async function readCommandLog(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
