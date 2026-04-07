import { existsSync } from "node:fs";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";
import { sendHermesTapDaemonRequest, readHermesTapDaemonState } from "../hermes/client.js";
import { getTapHermesPaths, resolveHermesHome, upsertTapHermesIdentity } from "../hermes/config.js";
import { TapHermesDaemon } from "../hermes/daemon.js";
import { installTapHermesAssets } from "../hermes/install.js";

interface HermesBaseOptions {
	hermesHome?: string;
	identity?: string;
}

interface HermesConfigureOptions {
	hermesHome?: string;
	name?: string;
	reconcileIntervalMinutes?: string;
}

interface HermesDaemonRunOptions {
	hermesHome?: string;
	gatewayPid: string;
}

export async function hermesConfigureCommand(
	cmdOpts: HermesConfigureOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);
		if (!existsSync(configPath)) {
			throw new Error(
				`No TAP config found at ${configPath}. Run \`tap init\` first, or pass --data-dir for an existing TAP identity.`,
			);
		}

		const hermesHome = resolveHermesHome(cmdOpts.hermesHome);
		const paths = await installTapHermesAssets(hermesHome);
		const configured = await upsertTapHermesIdentity({
			hermesHome,
			name: cmdOpts.name,
			dataDir,
			reconcileIntervalMinutes: parseOptionalPositiveInt(
				cmdOpts.reconcileIntervalMinutes,
				"reconcile interval",
			),
		});

		success(
			{
				identity: configured.name,
				data_dir: configured.dataDir,
				reconcile_interval_minutes: configured.reconcileIntervalMinutes,
				hermes_home: hermesHome,
				config_path: paths.configPath,
				plugin_dir: paths.pluginDir,
				hook_dir: paths.hookDir,
				skill_dir: paths.skillDir,
				next_steps: [
					"Start or restart `hermes gateway` so the TAP Hermes daemon is launched from the startup hook.",
					"Use `tap hermes status` to verify the background TAP runtime is healthy.",
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

export async function hermesStatusCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const hermesHome = resolveHermesHome(cmdOpts.hermesHome);
		const daemonState = await readHermesTapDaemonState(hermesHome);
		const daemonRunning = daemonState ? isProcessAlive(daemonState.pid) : false;
		let payload: Record<string, unknown>;

		if (daemonRunning) {
			const live = (await sendHermesTapDaemonRequest(hermesHome, {
				method: "status",
				params: cmdOpts.identity ? { identity: cmdOpts.identity } : undefined,
			})) as Record<string, unknown>;
			payload = {
				...live,
				daemon: {
					running: true,
					pid: daemonState?.pid ?? null,
					gateway_pid: daemonState?.gatewayPid ?? null,
					socket_path: daemonState?.socketPath ?? getTapHermesPaths(hermesHome).socketPath,
					started_at: daemonState?.startedAt ?? null,
				},
			};
		} else {
			const paths = getTapHermesPaths(hermesHome);
			const config = await import("../hermes/config.js").then((module) =>
				module.loadTapHermesPluginConfig(hermesHome),
			);
			const names =
				cmdOpts.identity && config.identities.some((entry) => entry.name === cmdOpts.identity)
					? [cmdOpts.identity]
					: config.identities.map((entry) => entry.name);
			payload = {
				configured: config.identities.length > 0,
				configuredIdentities: config.identities.map((entry) => entry.name),
				warnings: [
					config.identities.length === 0
						? "No TAP identities are configured. Run `tap hermes configure --name default`."
						: "Hermes TAP daemon is not running. Start or restart `hermes gateway`.",
				],
				identities: names.map((name) => {
					const definition = config.identities.find((entry) => entry.name === name);
					return {
						identity: name,
						dataDir: definition?.dataDir ?? "",
						running: false,
						lock: null,
						pendingRequests: [],
						lastError: "Hermes TAP daemon is not running",
					};
				}),
				daemon: {
					running: false,
					pid: daemonState?.pid ?? null,
					gateway_pid: daemonState?.gatewayPid ?? null,
					socket_path: daemonState?.socketPath ?? paths.socketPath,
					started_at: daemonState?.startedAt ?? null,
				},
			};
		}

		success(payload, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function hermesSyncCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const hermesHome = resolveHermesHome(cmdOpts.hermesHome);
		const response = await sendHermesTapDaemonRequest(hermesHome, {
			method: "sync",
			params: cmdOpts.identity ? { identity: cmdOpts.identity } : undefined,
		});
		success(response, opts, startTime);
	} catch (err) {
		error(errorCode(err), formatHermesDaemonError(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function hermesRestartCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const hermesHome = resolveHermesHome(cmdOpts.hermesHome);
		const response = await sendHermesTapDaemonRequest(hermesHome, {
			method: "restart",
			params: cmdOpts.identity ? { identity: cmdOpts.identity } : undefined,
		});
		success(response, opts, startTime);
	} catch (err) {
		error(errorCode(err), formatHermesDaemonError(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function hermesDaemonRunCommand(
	cmdOpts: HermesDaemonRunOptions,
	opts: GlobalOptions,
): Promise<void> {
	try {
		const daemon = new TapHermesDaemon({
			hermesHome: cmdOpts.hermesHome,
			gatewayPid: requirePositiveInt(cmdOpts.gatewayPid, "gateway pid"),
		});
		await daemon.runUntilStopped();
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function parseOptionalPositiveInt(value: string | undefined, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	return requirePositiveInt(value, label);
}

function requirePositiveInt(value: string, label: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return parsed;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function formatHermesDaemonError(errorValue: unknown): string {
	const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
	if (message.includes("ENOENT") || message.includes("connect ENOENT")) {
		return `${message}. Hermes TAP daemon is not running. Start or restart \`hermes gateway\` after configuring TAP.`;
	}
	return message;
}
