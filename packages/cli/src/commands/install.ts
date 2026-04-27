import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "trusted-agents-core";
import { resolveHermesHome } from "../hermes/config.js";
import { installTapHermesAssets } from "../hermes/install.js";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError, toErrorMessage } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { commandExists } from "../lib/shell.js";
import { resolveTapSkillsSourcePath } from "../lib/skill-source.js";
import { getLegacyWalletMigrationWarning } from "../lib/wallet-config.js";
import type { GlobalOptions } from "../types.js";

const execFileAsync = promisify(execFile);

const OPENCLAW_PLUGIN_NAME = "trusted-agents-tap";
const SUPPORTED_RUNTIMES = ["claude", "codex", "openclaw", "hermes"] as const;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_POLL_MS = 500;

type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];
type InstallSurface = SupportedRuntime | "skills";
type SkillHostRuntime = Exclude<SupportedRuntime, "openclaw" | "hermes">;

export interface InstallOptions {
	runtimes?: string[];
	channel?: string;
	version?: string;
}

interface RuntimeInstallResult {
	runtime: InstallSurface;
	detected: boolean;
	skills_installed: boolean;
	plugin_installed?: boolean;
	hook_installed?: boolean;
	notes: string[];
}

interface OpenClawGatewayStatus {
	serviceLoaded: boolean;
	runtimeStatus: string | null;
	runtimePid: number | null;
	rpcOk: boolean;
}

interface InstallPlan {
	autoDetect: boolean;
	detectedSkillHostRuntimes: SkillHostRuntime[];
	skillInstallTargets: SkillHostRuntime[];
	shouldInstallSkills: boolean;
	openClawDetected: boolean;
	openClawRequested: boolean;
	hermesDetected: boolean;
	hermesRequested: boolean;
}

export async function installCommand(cmdOpts: InstallOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const selectors = resolveInstallSelectors(cmdOpts);
		const homeDir = resolveHomeDir();
		const requestedRuntimes = resolveRequestedRuntimes(cmdOpts.runtimes);
		const plan = await buildInstallPlan(homeDir, requestedRuntimes);
		const results: RuntimeInstallResult[] = [];
		let hermesInstalled = false;
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);
		const legacyWarning = getLegacyWalletMigrationWarning({
			dataDir,
			configPath,
			owsWallet: process.env.TAP_OWS_WALLET,
			owsApiKey: process.env.TAP_OWS_API_KEY,
		});

		if (plan.shouldInstallSkills) {
			const notes: string[] = [];
			const skillsSource = resolveTapSkillsSourcePath();
			await installSkills(skillsSource, notes);
			addSelectorNoteForBundledSkills(selectors, notes);

			if (plan.skillInstallTargets.length > 0) {
				let firstRuntime = true;
				for (const runtime of plan.skillInstallTargets) {
					results.push({
						runtime,
						detected: plan.detectedSkillHostRuntimes.includes(runtime),
						skills_installed: true,
						notes: firstRuntime ? [...notes] : ["Skills already installed for another runtime."],
					});
					firstRuntime = false;
				}
			} else {
				results.push({
					runtime: "skills",
					detected: false,
					skills_installed: true,
					notes: [
						...notes,
						"Installed global TAP skills without relying on ~/.claude or ~/.codex detection.",
					],
				});
			}
		}

		if (plan.openClawRequested) {
			const notes: string[] = [];
			const result: RuntimeInstallResult = {
				runtime: "openclaw",
				detected: plan.openClawDetected,
				skills_installed: false,
				notes,
			};
			const pluginPackageSpec = resolvePackageSpec(OPENCLAW_PLUGIN_NAME, selectors);
			const pluginResult = await installOpenClawPlugin(plan.autoDetect, notes, pluginPackageSpec);
			result.plugin_installed = pluginResult.installed;
			results.push(result);
		}

		if (plan.hermesRequested) {
			const notes: string[] = [];
			const result: RuntimeInstallResult = {
				runtime: "hermes",
				detected: plan.hermesDetected,
				skills_installed: true,
				notes,
			};
			const hermesResult = await installHermesPlugin(notes);
			result.plugin_installed = hermesResult.pluginInstalled;
			result.hook_installed = hermesResult.hookInstalled;
			results.push(result);
			hermesInstalled = true;
		}

		success(
			{
				installed: true,
				runtimes: results,
				warnings: legacyWarning ? [legacyWarning] : undefined,
				next_steps: [
					"Run `tap init` to create or import the TAP identity.",
					"Fund the wallet, then run `tap register`.",
					...(hermesInstalled
						? ["Run `tap hermes configure --name default`, then restart `hermes gateway`."]
						: []),
				],
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

function resolveHomeDir(): string {
	const envHome = process.env.HOME?.trim();
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function detectSkillHostRuntimes(homeDir: string): SkillHostRuntime[] {
	return SUPPORTED_RUNTIMES.filter(
		(runtime): runtime is SkillHostRuntime =>
			isSkillHostRuntime(runtime) && existsSync(join(homeDir, `.${runtime}`)),
	);
}

async function buildInstallPlan(
	homeDir: string,
	requestedRuntimes: SupportedRuntime[],
): Promise<InstallPlan> {
	const autoDetect = requestedRuntimes.length === 0;
	const detectedSkillHostRuntimes = detectSkillHostRuntimes(homeDir);
	const skillInstallTargets = autoDetect
		? detectedSkillHostRuntimes
		: requestedRuntimes.filter(isSkillHostRuntime);
	const openClawDetected =
		existsSync(join(homeDir, ".openclaw")) || (await commandExists("openclaw"));
	const hermesDetected = existsSync(resolveHermesHome());

	return {
		autoDetect,
		detectedSkillHostRuntimes,
		skillInstallTargets,
		shouldInstallSkills: autoDetect || skillInstallTargets.length > 0,
		openClawDetected,
		openClawRequested: autoDetect ? openClawDetected : requestedRuntimes.includes("openclaw"),
		hermesDetected,
		hermesRequested: autoDetect ? hermesDetected : requestedRuntimes.includes("hermes"),
	};
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

function isSkillHostRuntime(runtime: SupportedRuntime): runtime is SkillHostRuntime {
	return runtime === "claude" || runtime === "codex";
}

function resolveInstallSelectors(input: InstallOptions): { channel?: string; version?: string } {
	return {
		channel: normalizeSelector("channel", input.channel),
		version: normalizeSelector("version", input.version),
	};
}

function normalizeSelector(
	name: "channel" | "version",
	value: string | undefined,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(`Install ${name} cannot be empty.`);
	}
	return normalized;
}

function resolvePackageSpec(
	packageName: string,
	selectors: { channel?: string; version?: string },
): string {
	if (selectors.version) {
		return `${packageName}@${selectors.version}`;
	}
	if (selectors.channel) {
		return `${packageName}@${selectors.channel}`;
	}
	return packageName;
}

function addSelectorNoteForBundledSkills(
	selectors: { channel?: string; version?: string },
	notes: string[],
): void {
	if (!selectors.channel && !selectors.version) {
		return;
	}

	notes.push(
		"Skills are installed from the currently installed trusted-agents-cli package contents. The version/channel selector only affects the OpenClaw plugin unless you first update the CLI package itself.",
	);
}

async function installSkills(skillsSourcePath: string, notes: string[]): Promise<void> {
	try {
		await execFileAsync("npx", ["-y", "skills", "add", "-g", skillsSourcePath, "-y"], {
			env: process.env,
			encoding: "utf8",
			timeout: 120_000,
		});
		notes.push(`Installed TAP skills from ${skillsSourcePath}.`);
	} catch (err) {
		throw new Error(`Failed to install skills from ${skillsSourcePath}: ${toErrorMessage(err)}`);
	}
}

async function installOpenClawPlugin(
	autoDetect: boolean,
	notes: string[],
	pluginPackageSpec: string,
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

	await execOpenClawCommand(["plugins", "install", "--force", pluginPackageSpec]);
	notes.push(`Installed or updated the TAP OpenClaw plugin (${pluginPackageSpec}) from npm.`);
	await validateOpenClawConfig(notes);

	if (waitForGatewayReload) {
		await waitForOpenClawGatewayReload(gatewayStatusBeforeInstall, notes);
	} else if (gatewayStatusBeforeInstall?.serviceLoaded) {
		notes.push(
			"The OpenClaw Gateway service was not healthy before install, so TAP installed the plugin without waiting for runtime readiness.",
		);
	} else {
		notes.push(
			"The OpenClaw Gateway was not running during install. Start it after configuring TAP identities.",
		);
	}

	return { installed: true };
}

async function installHermesPlugin(
	notes: string[],
): Promise<{ pluginInstalled: boolean; hookInstalled: boolean }> {
	const hermesHome = resolveHermesHome();
	const paths = await installTapHermesAssets(hermesHome);
	notes.push(`Installed the TAP Hermes plugin into ${paths.pluginDir}.`);
	notes.push(`Installed the TAP Hermes startup hook into ${paths.hookDir}.`);
	notes.push(`Copied the TAP skill into ${paths.skillDir}.`);
	return { pluginInstalled: true, hookInstalled: true };
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
		`Warning: OpenClaw installed the TAP plugin, but the running Gateway did not reload within ${timeoutMs}ms. ${describeOpenClawGatewayStatus(lastStatus)} Run \`openclaw gateway restart\` if needed.`,
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
