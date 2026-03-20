import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { commandExists } from "../lib/shell.js";
import type { GlobalOptions } from "../types.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_RUNTIMES = ["claude", "codex", "openclaw"] as const;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_POLL_MS = 500;

type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

export interface InstallOptions {
	sourceDir?: string;
	runtimes?: string[];
	skipSkills?: boolean;
}

interface RuntimeInstallResult {
	runtime: SupportedRuntime;
	detected: boolean;
	skills_linked: boolean;
	skills_path?: string;
	plugin_installed?: boolean;
	plugin_target?: string;
	notes: string[];
}

interface OpenClawGatewayStatus {
	serviceLoaded: boolean;
	runtimeStatus: string | null;
	runtimePid: number | null;
	rpcOk: boolean;
}

export async function installCommand(cmdOpts: InstallOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const sourceDir = resolveSourceDir(cmdOpts.sourceDir);
		validateSourceDir(sourceDir);
		const homeDir = resolveHomeDir();

		const runtimes = resolveRequestedRuntimes(cmdOpts.runtimes);
		const autoDetect = runtimes.length === 0;
		const skillSource = join(sourceDir, "packages", "sdk", "skills", "trusted-agents");
		const pluginSource = join(sourceDir, "packages", "openclaw-plugin");
		const results: RuntimeInstallResult[] = [];

		for (const runtime of autoDetect ? SUPPORTED_RUNTIMES : runtimes) {
			const runtimeDir = join(homeDir, `.${runtime}`);
			const detected =
				existsSync(runtimeDir) || (runtime === "openclaw" && (await commandExists("openclaw")));
			if (autoDetect && !detected) {
				continue;
			}

			const notes: string[] = [];
			const result: RuntimeInstallResult = {
				runtime,
				detected,
				skills_linked: false,
				notes,
			};

			if (shouldLinkGenericSkills(runtime, cmdOpts.skipSkills)) {
				const linkPath = await ensureSkillLink(runtimeDir, skillSource);
				result.skills_linked = true;
				result.skills_path = linkPath;
			} else if (cmdOpts.skipSkills) {
				notes.push("Skipped generic TAP skill linking.");
			} else if (runtime === "openclaw") {
				notes.push("OpenClaw uses plugin-bundled TAP skills; skipped generic TAP skill linking.");
			}

			if (runtime === "openclaw") {
				const pluginResult = await installOpenClawPlugin(
					pluginSource,
					skillSource,
					runtimeDir,
					autoDetect,
					notes,
				);
				result.plugin_installed = pluginResult.installed;
				result.plugin_target = pluginSource;
			}

			results.push(result);
		}

		if (results.length === 0) {
			success(
				{
					source_dir: sourceDir,
					installed: false,
					reason:
						"No supported runtimes detected. Looked for ~/.claude, ~/.codex, ~/.openclaw, and the openclaw CLI.",
					next_steps: [
						"Create the target runtime directory or pass --runtime <name> to install explicitly.",
					],
				},
				opts,
				startTime,
			);
			return;
		}

		success(
			{
				source_dir: sourceDir,
				installed: true,
				runtimes: results,
				next_steps: [
					"Run `tap init` to create or import the TAP identity.",
					"Fund the wallet, then run `tap register`.",
					"In OpenClaw, configure the plugin identity with the TAP data dir after onboarding.",
				],
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function resolveSourceDir(input?: string): string {
	if (input) {
		return resolve(input);
	}

	const envDir = process.env.TAP_SOURCE_DIR;
	if (envDir) {
		return resolve(envDir);
	}

	const currentFile = fileURLToPath(import.meta.url);
	return resolve(dirname(currentFile), "../../../../");
}

function resolveHomeDir(): string {
	const envHome = process.env.HOME?.trim();
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function validateSourceDir(sourceDir: string): void {
	const cliBin = join(sourceDir, "packages", "cli", "dist", "bin.js");
	const skillSource = join(sourceDir, "packages", "sdk", "skills", "trusted-agents");
	const pluginSource = join(sourceDir, "packages", "openclaw-plugin", "openclaw.plugin.json");

	if (!existsSync(cliBin)) {
		throw new Error(
			`TAP source dir is missing the built CLI at ${cliBin}. Run the repo build first.`,
		);
	}
	if (!existsSync(skillSource)) {
		throw new Error(`TAP source dir is missing the generic skill tree at ${skillSource}.`);
	}
	if (!existsSync(pluginSource)) {
		throw new Error(`TAP source dir is missing the OpenClaw plugin at ${pluginSource}.`);
	}
}

function resolveRequestedRuntimes(input: string[] | undefined): SupportedRuntime[] {
	if (!input || input.length === 0) {
		return [];
	}

	return input.map((entry) => parseRuntime(entry));
}

function parseRuntime(value: string): SupportedRuntime {
	const normalized = value.trim().toLowerCase();
	const match = SUPPORTED_RUNTIMES.find((runtime) => runtime === normalized);
	if (!match) {
		throw new Error(`Unsupported runtime: ${value}. Use one of: ${SUPPORTED_RUNTIMES.join(", ")}`);
	}
	return match;
}

function shouldLinkGenericSkills(
	runtime: SupportedRuntime,
	skipSkills: boolean | undefined,
): boolean {
	return !skipSkills && runtime !== "openclaw";
}

async function ensureSkillLink(runtimeDir: string, skillSource: string): Promise<string> {
	const skillsDir = join(runtimeDir, "skills");
	const linkPath = join(skillsDir, "trusted-agents");
	await mkdir(skillsDir, { recursive: true });

	const existing = await readSymlinkTarget(linkPath);
	if (existing !== null) {
		if (existing === skillSource) {
			return linkPath;
		}
		throw new Error(`${linkPath} exists and is not a TAP-managed symlink.`);
	}

	if (await pathExists(linkPath)) {
		throw new Error(`${linkPath} exists and is not a symlink.`);
	}

	await symlink(skillSource, linkPath);
	return linkPath;
}

async function installOpenClawPlugin(
	pluginSource: string,
	skillSource: string,
	openClawDir: string,
	autoDetect: boolean,
	notes: string[],
): Promise<{ installed: boolean }> {
	const hasOpenClaw = await commandExists("openclaw");
	if (!hasOpenClaw) {
		if (autoDetect) {
			notes.push("OpenClaw CLI not found; skipped plugin installation.");
			return { installed: false };
		}
		throw new Error("OpenClaw CLI not found on PATH. Install OpenClaw or omit --runtime openclaw.");
	}

	const gatewayStatusBeforeInstall = await getOpenClawGatewayStatus();
	const waitForGatewayReload = isHealthyOpenClawGatewayStatus(gatewayStatusBeforeInstall);

	await cleanupLegacyOpenClawSkillLink(openClawDir, skillSource, notes);
	await execOpenClawCommand(["plugins", "install", "--link", pluginSource]);
	notes.push("Installed or refreshed the TAP OpenClaw plugin link.");
	await validateOpenClawConfig(notes);

	if (waitForGatewayReload) {
		await waitForOpenClawGatewayReload(gatewayStatusBeforeInstall, notes);
	} else if (gatewayStatusBeforeInstall?.serviceLoaded) {
		notes.push(
			"The OpenClaw Gateway service was not healthy before install, so TAP updated the plugin link without waiting for runtime readiness.",
		);
	} else {
		notes.push(
			"The OpenClaw Gateway was not running during install. Start it after configuring TAP identities.",
		);
	}

	return { installed: true };
}

async function cleanupLegacyOpenClawSkillLink(
	openClawDir: string,
	skillSource: string,
	notes: string[],
): Promise<void> {
	const legacyLinkPath = join(openClawDir, "skills", "trusted-agents");
	const existingTarget = await readSymlinkTarget(legacyLinkPath);
	if (existingTarget !== null) {
		if (existingTarget === skillSource || looksLikeLegacyTapSkillTarget(existingTarget)) {
			await rm(legacyLinkPath, { force: true });
			notes.push(
				"Removed the legacy ~/.openclaw/skills/trusted-agents TAP symlink. OpenClaw plugin mode uses the plugin-bundled skill tree only.",
			);
			return;
		}

		notes.push(
			"Found an existing ~/.openclaw/skills/trusted-agents symlink. OpenClaw plugin mode does not use generic TAP skills; remove that symlink if Gateway logs TAP skill-path warnings.",
		);
		return;
	}

	if (await pathExists(legacyLinkPath)) {
		notes.push(
			"Found an existing ~/.openclaw/skills/trusted-agents entry that is not a symlink. OpenClaw plugin mode does not use generic TAP skills; remove or rename it if Gateway logs TAP skill-path warnings.",
		);
	}
}

async function validateOpenClawConfig(notes: string[]): Promise<void> {
	const result = await execOpenClawJsonCommand(["config", "validate", "--json"]);
	if (result.valid !== true) {
		const issues = Array.isArray(result.issues)
			? result.issues
					.map((issue) => {
						if (!isRecord(issue)) {
							return null;
						}
						const message = typeof issue.message === "string" ? issue.message.trim() : "";
						return message || null;
					})
					.filter((message): message is string => Boolean(message))
			: [];
		const detail =
			issues.length > 0
				? issues.join("; ")
				: "OpenClaw reported an invalid config after plugin install.";
		throw new Error(`OpenClaw config validation failed after plugin install: ${detail}`);
	}
	notes.push("Validated the OpenClaw config after plugin install.");
}

async function getOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus> {
	const result = await execOpenClawJsonCommand(["gateway", "status", "--json"]);
	return parseOpenClawGatewayStatus(result);
}

async function readOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus | null> {
	try {
		return await getOpenClawGatewayStatus();
	} catch {
		return null;
	}
}

function parseOpenClawGatewayStatus(result: Record<string, unknown>): OpenClawGatewayStatus {
	const service = isRecord(result.service) ? result.service : {};
	const runtime = isRecord(service.runtime) ? service.runtime : {};
	const rpc = isRecord(result.rpc) ? result.rpc : {};
	const rawPid = runtime.pid;

	return {
		serviceLoaded: service.loaded === true,
		runtimeStatus: typeof runtime.status === "string" ? runtime.status : null,
		runtimePid: typeof rawPid === "number" && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null,
		rpcOk: rpc.ok === true,
	};
}

function isHealthyOpenClawGatewayStatus(
	status: OpenClawGatewayStatus | null,
): status is OpenClawGatewayStatus & { runtimePid: number } {
	return (
		status?.serviceLoaded === true &&
		status.runtimeStatus === "running" &&
		typeof status.runtimePid === "number" &&
		status.rpcOk
	);
}

async function waitForOpenClawGatewayReload(
	statusBeforeInstall: OpenClawGatewayStatus & { runtimePid: number },
	notes: string[],
): Promise<void> {
	const timeoutMs = readPositiveIntegerEnv(
		"TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS",
		DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS,
	);
	const pollMs = readPositiveIntegerEnv(
		"TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS",
		DEFAULT_OPENCLAW_GATEWAY_WAIT_POLL_MS,
	);
	const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
	let lastStatus: OpenClawGatewayStatus | null = statusBeforeInstall;

	notes.push("Detected a running OpenClaw Gateway and waiting for the plugin reload to finish.");

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await sleep(pollMs);
		lastStatus = await readOpenClawGatewayStatus();
		if (
			isHealthyOpenClawGatewayStatus(lastStatus) &&
			lastStatus.runtimePid !== statusBeforeInstall.runtimePid
		) {
			notes.push(
				`Waited for the OpenClaw Gateway to reload the TAP plugin (pid ${statusBeforeInstall.runtimePid} -> ${lastStatus.runtimePid}).`,
			);
			return;
		}
	}

	notes.push(
		`Warning: OpenClaw installed the TAP plugin link, but the running Gateway did not reload within ${timeoutMs}ms. ${describeOpenClawGatewayStatus(lastStatus)} Run \`openclaw gateway restart\` if needed.`,
	);
}

function describeOpenClawGatewayStatus(status: OpenClawGatewayStatus | null): string {
	if (status === null) {
		return "Gateway status could not be read during the reload wait.";
	}

	const parts = [
		`serviceLoaded=${String(status.serviceLoaded)}`,
		`runtimeStatus=${status.runtimeStatus ?? "unknown"}`,
		`runtimePid=${status.runtimePid ?? "unknown"}`,
		`rpcOk=${String(status.rpcOk)}`,
	];
	return `Last observed Gateway status: ${parts.join(", ")}.`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const rawValue = process.env[name];
	if (!rawValue) {
		return fallback;
	}

	const value = Number(rawValue);
	if (!Number.isInteger(value) || value <= 0) {
		return fallback;
	}
	return value;
}

async function execOpenClawCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return await execFileAsync("openclaw", args, {
		env: process.env,
		encoding: "utf8",
	});
}

async function execOpenClawJsonCommand(args: string[]): Promise<Record<string, unknown>> {
	const { stdout } = await execOpenClawCommand(args);
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error(`OpenClaw returned no JSON output for: openclaw ${args.join(" ")}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		const normalizedErr = err instanceof Error ? err : new Error(String(err));
		throw new Error(
			`OpenClaw returned invalid JSON for: openclaw ${args.join(" ")} (${normalizedErr.message})`,
		);
	}

	if (!isRecord(parsed)) {
		throw new Error(`OpenClaw returned an unexpected JSON payload for: openclaw ${args.join(" ")}`);
	}

	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeLegacyTapSkillTarget(path: string): boolean {
	const suffix = join("packages", "sdk", "skills", "trusted-agents");
	return path.endsWith(suffix);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readSymlinkTarget(path: string): Promise<string | null> {
	try {
		const stat = await lstat(path);
		if (!stat.isSymbolicLink()) {
			return null;
		}
		return resolve(dirname(path), await readlink(path));
	} catch {
		return null;
	}
}
