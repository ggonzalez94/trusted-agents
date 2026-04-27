import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readJsonFileOrDefault, writeJsonFileAtomic } from "../lib/atomic-write.js";

export interface TapHermesIdentityConfig {
	name: string;
	dataDir: string;
	reconcileIntervalMinutes: number;
}

export interface TapHermesPluginConfig {
	identities: TapHermesIdentityConfig[];
}

export interface TapHermesDaemonState {
	pid: number;
	gatewayPid: number;
	socketPath: string;
	startedAt: string;
	identities: string[];
}

export interface TapHermesPaths {
	hermesHome: string;
	pluginDir: string;
	hookDir: string;
	skillDir: string;
	configPath: string;
	stateDir: string;
	socketPath: string;
	daemonStatePath: string;
	daemonLogPath: string;
	notificationPath: string;
	notificationLockPath: string;
}

export interface UpsertTapHermesIdentityOptions {
	hermesHome?: string;
	name?: string;
	dataDir: string;
	reconcileIntervalMinutes?: number;
}

export const DEFAULT_HERMES_RECONCILE_INTERVAL_MINUTES = 10;

export function resolveHermesHome(hermesHome?: string): string {
	const envHome = process.env.HERMES_HOME?.trim();
	const selected = hermesHome?.trim() || envHome || join(process.env.HOME ?? homedir(), ".hermes");
	return resolve(selected);
}

export function getTapHermesPaths(hermesHome?: string): TapHermesPaths {
	const resolvedHome = resolveHermesHome(hermesHome);
	const pluginDir = join(resolvedHome, "plugins", "trusted-agents-tap");
	const stateDir = join(pluginDir, "state");
	return {
		hermesHome: resolvedHome,
		pluginDir,
		hookDir: join(resolvedHome, "hooks", "trusted-agents-tap"),
		skillDir: join(resolvedHome, "skills", "trusted-agents"),
		configPath: join(pluginDir, "config.json"),
		stateDir,
		socketPath: join(stateDir, "tap-hermes.sock"),
		daemonStatePath: join(stateDir, "daemon.json"),
		daemonLogPath: join(stateDir, "daemon.log"),
		notificationPath: join(stateDir, "notifications.json"),
		notificationLockPath: join(stateDir, "notifications.lock"),
	};
}

export function parseTapHermesPluginConfig(raw: unknown): TapHermesPluginConfig {
	if (raw === undefined || raw === null) {
		return { identities: [] };
	}

	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("TAP Hermes plugin config must be an object");
	}

	const input = raw as { identities?: unknown };
	if (input.identities === undefined) {
		return { identities: [] };
	}
	if (!Array.isArray(input.identities)) {
		throw new Error("TAP Hermes plugin config.identities must be an array");
	}

	const identities = input.identities.map((value, index) => parseIdentityConfig(value, index));
	const names = new Set<string>();
	const dataDirs = new Set<string>();
	for (const identity of identities) {
		if (names.has(identity.name)) {
			throw new Error(`Duplicate TAP Hermes identity name: ${identity.name}`);
		}
		names.add(identity.name);

		const normalizedDataDir = resolve(identity.dataDir);
		if (dataDirs.has(normalizedDataDir)) {
			throw new Error(`Duplicate TAP Hermes identity dataDir: ${identity.dataDir}`);
		}
		dataDirs.add(normalizedDataDir);
	}

	return { identities };
}

export async function loadTapHermesPluginConfig(
	hermesHome?: string,
): Promise<TapHermesPluginConfig> {
	const { configPath } = getTapHermesPaths(hermesHome);
	return readJsonFileOrDefault(configPath, parseTapHermesPluginConfig, { identities: [] });
}

export async function saveTapHermesPluginConfig(
	hermesHome: string | undefined,
	config: TapHermesPluginConfig,
): Promise<void> {
	const { configPath } = getTapHermesPaths(hermesHome);
	const normalized = parseTapHermesPluginConfig(config);
	await writeJsonFileAtomic(configPath, normalized);
}

export async function upsertTapHermesIdentity(
	options: UpsertTapHermesIdentityOptions,
): Promise<TapHermesIdentityConfig> {
	const hermesHome = resolveHermesHome(options.hermesHome);
	const config = await loadTapHermesPluginConfig(hermesHome);
	const name = trimmedNonEmptyString(options.name) ?? "default";
	const reconcileIntervalMinutes = normalizeReconcileInterval(options.reconcileIntervalMinutes);
	const nextIdentity: TapHermesIdentityConfig = {
		name,
		dataDir: resolve(options.dataDir.trim()),
		reconcileIntervalMinutes,
	};

	const nextIdentities = config.identities.filter((identity) => identity.name !== name);
	nextIdentities.push(nextIdentity);
	nextIdentities.sort((left, right) => left.name.localeCompare(right.name));
	await saveTapHermesPluginConfig(hermesHome, { identities: nextIdentities });
	return nextIdentity;
}

export async function loadTapHermesDaemonState(
	hermesHome?: string,
): Promise<TapHermesDaemonState | null> {
	const { daemonStatePath } = getTapHermesPaths(hermesHome);
	return readJsonFileOrDefault(daemonStatePath, parseTapHermesDaemonState, null);
}

export async function saveTapHermesDaemonState(
	hermesHome: string | undefined,
	state: TapHermesDaemonState,
): Promise<void> {
	const { daemonStatePath } = getTapHermesPaths(hermesHome);
	await writeJsonFileAtomic(daemonStatePath, parseTapHermesDaemonState(state));
}

function parseIdentityConfig(value: unknown, index: number): TapHermesIdentityConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`TAP Hermes identity at index ${index} must be an object`);
	}

	const input = value as {
		name?: unknown;
		dataDir?: unknown;
		reconcileIntervalMinutes?: unknown;
	};

	const dataDir = requireTrimmedNonEmptyString(
		input.dataDir,
		`TAP Hermes identity ${index + 1} is missing a valid dataDir`,
	);

	const name =
		trimmedNonEmptyString(input.name) ?? (index === 0 ? "default" : `identity-${index + 1}`);

	return {
		name,
		dataDir: resolve(dataDir),
		reconcileIntervalMinutes: normalizeReconcileInterval(input.reconcileIntervalMinutes),
	};
}

function parseTapHermesDaemonState(raw: unknown): TapHermesDaemonState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("Invalid TAP Hermes daemon state");
	}

	const input = raw as {
		pid?: unknown;
		gatewayPid?: unknown;
		socketPath?: unknown;
		startedAt?: unknown;
		identities?: unknown;
	};

	if (!isFinitePositiveInteger(input.pid)) {
		throw new Error("Invalid TAP Hermes daemon state pid");
	}
	if (!isFinitePositiveInteger(input.gatewayPid)) {
		throw new Error("Invalid TAP Hermes daemon state gatewayPid");
	}
	const socketPath = requireTrimmedNonEmptyString(
		input.socketPath,
		"Invalid TAP Hermes daemon state socketPath",
	);
	const startedAt = requireTrimmedNonEmptyString(
		input.startedAt,
		"Invalid TAP Hermes daemon state startedAt",
	);
	if (
		!Array.isArray(input.identities) ||
		input.identities.some((value) => typeof value !== "string")
	) {
		throw new Error("Invalid TAP Hermes daemon state identities");
	}

	return {
		pid: input.pid,
		gatewayPid: input.gatewayPid,
		socketPath,
		startedAt,
		identities: input.identities,
	};
}

function normalizeReconcileInterval(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
		return value;
	}
	return DEFAULT_HERMES_RECONCILE_INTERVAL_MINUTES;
}

function isFinitePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function trimmedNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function requireTrimmedNonEmptyString(value: unknown, message: string): string {
	const trimmed = trimmedNonEmptyString(value);
	if (trimmed === null) throw new Error(message);
	return trimmed;
}
