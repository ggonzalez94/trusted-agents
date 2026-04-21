import { existsSync } from "node:fs";
import {
	getTapHermesPaths,
	loadTapHermesPluginConfig,
	resolveHermesHome,
	upsertTapHermesIdentity,
} from "../hermes/config.js";
import { installTapHermesAssets } from "../hermes/install.js";
import { resolveConfigPath, resolveDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError, toErrorMessage } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";
import { daemonRestartCommand } from "./daemon-restart.js";
import { daemonStatusCommand } from "./daemon-status.js";
import { messageSyncCommand } from "./message-sync.js";

interface HermesBaseOptions {
	hermesHome?: string;
	identity?: string;
}

interface HermesConfigureOptions {
	hermesHome?: string;
	name?: string;
	reconcileIntervalMinutes?: string;
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
					"Start or restart `hermes gateway` so the Hermes startup hook launches tapd.",
					"Use `tap hermes status` (or `tap daemon status`) to verify tapd is healthy.",
				],
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), toErrorMessage(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

/**
 * Resolve `--identity` (and `--hermes-home`) to a concrete data dir so
 * `tap hermes <alias>` targets the selected identity's daemon rather than
 * falling back to whichever data dir happens to be the default.
 */
async function resolveHermesScopedOpts(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<GlobalOptions> {
	if (!cmdOpts.identity) return opts;
	const config = await loadTapHermesPluginConfig(cmdOpts.hermesHome);
	const identity = config.identities.find((i) => i.name === cmdOpts.identity);
	if (!identity) {
		throw new Error(
			`Hermes identity '${cmdOpts.identity}' is not configured. Run 'tap hermes configure --name ${cmdOpts.identity}' from that data dir first.`,
		);
	}
	return { ...opts, dataDir: identity.dataDir };
}

/**
 * Thin wrapper that forwards to `tap daemon status`. The Hermes wrapper
 * exists so operators who learned the `tap hermes` command surface keep
 * a working muscle memory after the Phase 4 daemon consolidation.
 */
export async function hermesStatusCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	// Ensure paths are valid — resolves HERMES_HOME side effect but otherwise
	// doesn't alter tapd's status. Kept as a lightweight sanity check.
	getTapHermesPaths(cmdOpts.hermesHome);
	const scopedOpts = await resolveHermesScopedOpts(cmdOpts, opts);
	await daemonStatusCommand(scopedOpts);
}

/**
 * Thin wrapper that forwards to the `tap sync` command semantics, which
 * routes through tapd when the daemon is running.
 */
export async function hermesSyncCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	const scopedOpts = await resolveHermesScopedOpts(cmdOpts, opts);
	await messageSyncCommand(scopedOpts);
}

/**
 * Thin wrapper that forwards to `tap daemon restart`. Kept for muscle
 * memory; there is only one daemon to restart after Phase 4.
 */
export async function hermesRestartCommand(
	cmdOpts: HermesBaseOptions,
	opts: GlobalOptions,
): Promise<void> {
	const scopedOpts = await resolveHermesScopedOpts(cmdOpts, opts);
	await daemonRestartCommand(scopedOpts);
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
