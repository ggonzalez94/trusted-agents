import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_RUNTIMES = ["claude", "codex", "openclaw"] as const;

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
	service?: {
		loaded?: boolean;
		label?: string;
	};
	port?: {
		status?: string;
		listeners?: OpenClawGatewayListener[];
	};
}

interface OpenClawGatewayListener {
	pid?: number;
	command?: string;
	commandLine?: string;
}

interface PreparedOpenClawPluginInstall {
	restoreCommand?: string[];
	restoreNote?: string;
	serviceWasLoaded: boolean;
}

export async function installCommand(cmdOpts: InstallOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const sourceDir = resolveSourceDir(cmdOpts.sourceDir);
		validateSourceDir(sourceDir);

		const runtimes = resolveRequestedRuntimes(cmdOpts.runtimes);
		const autoDetect = runtimes.length === 0;
		const skillSource = join(sourceDir, "packages", "sdk", "skills", "trusted-agents");
		const pluginSource = join(sourceDir, "packages", "openclaw-plugin");
		const results: RuntimeInstallResult[] = [];

		for (const runtime of autoDetect ? SUPPORTED_RUNTIMES : runtimes) {
			const runtimeDir = join(homedir(), `.${runtime}`);
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
				const pluginResult = await installOpenClawPlugin(pluginSource, autoDetect, notes);
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

	const gatewayState = await prepareOpenClawPluginInstall(notes);
	let installError: Error | null = null;
	let restartError: Error | null = null;

	try {
		await execOpenClawCommand(["plugins", "install", "--link", pluginSource]);
		notes.push("Installed or refreshed the TAP OpenClaw plugin link.");
		await validateOpenClawConfig(notes);
	} catch (err) {
		installError = normalizeError(err);
	}

	if (gatewayState.serviceWasLoaded && gatewayState.restoreCommand) {
		try {
			await execOpenClawCommand(gatewayState.restoreCommand);
			if (gatewayState.restoreNote) {
				notes.push(gatewayState.restoreNote);
			}
		} catch (err) {
			restartError = normalizeError(err);
		}
	}

	if (installError && restartError) {
		throw new Error(
			`${installError.message} OpenClaw plugin install also failed to restart the gateway service: ${restartError.message}`,
		);
	}
	if (installError) {
		throw installError;
	}
	if (restartError) {
		throw new Error(
			`Installed the TAP OpenClaw plugin, but failed to restart the OpenClaw gateway service: ${restartError.message}`,
		);
	}

	return { installed: true };
}

async function prepareOpenClawPluginInstall(
	notes: string[],
): Promise<PreparedOpenClawPluginInstall> {
	const status = await getOpenClawGatewayStatus();
	const serviceWasLoaded = status.service?.loaded === true;
	const openClawListeners = getOpenClawListeners(status.port?.listeners);

	if (!serviceWasLoaded && openClawListeners.length > 0) {
		const listeners = formatOpenClawListeners(openClawListeners);
		throw new Error(
			`OpenClaw gateway is already running outside the managed service${listeners ? ` (${listeners})` : ""}. Stop that gateway process before running \`tap install --runtime openclaw\`. OpenClaw restarts the gateway when \`plugins.*\` config changes.`,
		);
	}

	if (!serviceWasLoaded) {
		return { serviceWasLoaded: false };
	}

	await execOpenClawCommand(["gateway", "stop"]);
	notes.push("Stopped the OpenClaw gateway service before updating plugin config.");
	return resolveOpenClawGatewayRestorePlan(status.service);
}

async function getOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus> {
	const status = await execOpenClawJsonCommand(["gateway", "status", "--json", "--no-probe"]);
	return status as OpenClawGatewayStatus;
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
		throw new Error(
			`OpenClaw returned invalid JSON for: openclaw ${args.join(" ")} (${normalizeError(err).message})`,
		);
	}

	if (!isRecord(parsed)) {
		throw new Error(`OpenClaw returned an unexpected JSON payload for: openclaw ${args.join(" ")}`);
	}

	return parsed;
}

function formatOpenClawListeners(listeners: OpenClawGatewayListener[] | undefined): string {
	if (!Array.isArray(listeners) || listeners.length === 0) {
		return "";
	}

	return listeners
		.slice(0, 2)
		.map((listener) => {
			const pid = typeof listener.pid === "number" ? `pid ${listener.pid}` : null;
			const command =
				typeof listener.commandLine === "string" && listener.commandLine.trim()
					? listener.commandLine.trim()
					: typeof listener.command === "string" && listener.command.trim()
						? listener.command.trim()
						: null;
			return [pid, command].filter(Boolean).join(" ");
		})
		.filter(Boolean)
		.join(", ");
}

function getOpenClawListeners(
	listeners: OpenClawGatewayListener[] | undefined,
): OpenClawGatewayListener[] {
	if (!Array.isArray(listeners)) {
		return [];
	}

	return listeners.filter((listener) => isOpenClawListener(listener));
}

function isOpenClawListener(listener: OpenClawGatewayListener): boolean {
	const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`.trim().toLowerCase();
	return raw.includes("openclaw");
}

function resolveOpenClawGatewayRestorePlan(
	service: OpenClawGatewayStatus["service"],
): PreparedOpenClawPluginInstall {
	if (isOpenClawLaunchAgent(service)) {
		return {
			serviceWasLoaded: true,
			restoreCommand: ["gateway", "install", "--force"],
			restoreNote: "Restored the OpenClaw LaunchAgent with the updated plugin config.",
		};
	}

	return {
		serviceWasLoaded: true,
		restoreCommand: ["gateway", "start"],
		restoreNote: "Restarted the OpenClaw gateway service with the updated plugin config.",
	};
}

function isOpenClawLaunchAgent(service: OpenClawGatewayStatus["service"]): boolean {
	return service?.label === "LaunchAgent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

async function commandExists(command: string): Promise<boolean> {
	const pathVar = process.env.PATH ?? "";
	for (const entry of pathVar.split(delimiter)) {
		if (!entry) {
			continue;
		}
		const candidate = join(entry, command);
		try {
			await access(candidate);
			return true;
		} catch {}
	}
	return false;
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
